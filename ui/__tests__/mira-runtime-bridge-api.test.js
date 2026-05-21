'use strict';

/* global afterEach, beforeAll, describe, expect, test */

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  evaluateCandidate,
  readVoiceLab,
} = require('../../mira/tools/evaluate-voice-lab');

describe('Mira runtime bridge manual-plan API', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const runtimeTsconfig = path.join(repoRoot, 'mira', 'runtime', 'tsconfig.json');
  const tscBin = path.join(repoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
  const compiledServerPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'server.js');
  let serverProcess;
  let openAiMockServer;
  let openAiRequests;
  let baseUrl;
  let tempStateRoot;
  const voiceLabPath = path.join(repoRoot, 'mira', 'voice', 'voice-lab-v0.jsonl');

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

  afterEach(async () => {
    if (!serverProcess) return;
    const closing = new Promise((resolve) => {
      serverProcess.once('close', resolve);
    });
    serverProcess.kill();
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(resolve, 1000);
    });
    await Promise.race([
      closing,
      timeout,
    ]);
    clearTimeout(timeoutId);
    serverProcess.stdout?.destroy();
    serverProcess.stderr?.destroy();
    serverProcess.removeAllListeners();
    serverProcess = null;
    baseUrl = null;
    if (tempStateRoot) {
      fs.rmSync(tempStateRoot, { recursive: true, force: true });
      tempStateRoot = null;
    }
    if (openAiMockServer) {
      await new Promise((resolve, reject) => {
        openAiMockServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      openAiMockServer = null;
      openAiRequests = null;
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

  async function waitForAutonomyLoopStatus() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await fetch(`${baseUrl}/autonomy/status`);
      const payload = await response.json();
      if (payload.loop?.status === 'ran') return payload;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('autonomy loop did not run');
  }

  function writeNormalizedCoreStateRoot() {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-turn-state-'));
    fs.mkdirSync(path.join(tempStateRoot, 'imports', 'receipts'), { recursive: true });
    fs.mkdirSync(path.join(tempStateRoot, 'continuity', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tempStateRoot, 'permissions', 'core'), { recursive: true });

    fs.writeFileSync(path.join(tempStateRoot, 'imports', 'receipts', 'normalized-core-state-v1-test.json'), JSON.stringify({
      schema: 'mira.normalized_core_receipt.v0',
      batch_id: 'normalized-core-state-v1',
      records: [
        {
          id: 'mira_self_profile',
          destination_relative_path: 'continuity/core/mira-self-profile.normalized.json',
          output_schema: 'mira.normalized.self_profile.v1',
        },
        {
          id: 'james_relationship_state',
          destination_relative_path: 'continuity/core/james-relationship-state.normalized.json',
          output_schema: 'mira.normalized.james_relationship_state.v1',
        },
        {
          id: 'relationship_presence_permissions',
          destination_relative_path: 'permissions/core/relationship-presence-permissions.normalized.json',
          output_schema: 'mira.normalized.relationship_presence_permissions.v1',
        },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(tempStateRoot, 'continuity', 'core', 'mira-self-profile.normalized.json'), JSON.stringify({
      schema: 'mira.normalized.self_profile.v1',
      profile_kind: 'ai_system_local_presence_profile',
      role: 'relationship_presence_local_start_proof',
      name: 'Mira',
      expressive_range_allowed: [
        'care',
        'directness',
        'opinion',
        'pushback',
        'humor',
        'curiosity',
        'friction',
      ],
      model_runtime_active: false,
      persona_runtime_active: false,
      source_metadata: {
        metadata_only: true,
        live_continuity_excluded: true,
      },
    }, null, 2));
    fs.writeFileSync(path.join(tempStateRoot, 'continuity', 'core', 'james-relationship-state.normalized.json'), JSON.stringify({
      schema: 'mira.normalized.james_relationship_state.v1',
      relationship_mode: 'collaborative_presence_design',
      what_mira_knows_about_james: 'James wants Mira to be caring, opinionated, friction-capable, and not a mirror.',
      preferences: [
        'Mira should develop her own posture, preferences, curiosity, friction, and rough edges over time',
        'care can coexist with disagreement, impatience, humor, and sharp pushback',
        'business and workflow work are capabilities, not Mira identity',
      ],
      source_metadata: {
        metadata_only: true,
        live_continuity_excluded: true,
      },
    }, null, 2));
    fs.writeFileSync(path.join(tempStateRoot, 'permissions', 'core', 'relationship-presence-permissions.normalized.json'), JSON.stringify({
      schema: 'mira.normalized.relationship_presence_permissions.v1',
      permissions: {
        read_local_redacted_context: true,
        propose_next_action: true,
        send_external: false,
        network: false,
        deploy: false,
        trade: false,
        runtime_start: false,
        fail_closed: true,
      },
      caveats: {
        local_store_write_allowed_now: 'scoped_only_to_reviewed_import_and_mira_state_root_writes_after_explicit_approval',
        blanket_mira_runtime_write_permission: false,
      },
      source_metadata: {
        metadata_only: true,
        live_continuity_excluded: true,
      },
    }, null, 2));

    return tempStateRoot;
  }

  function writeOperatorContext(stateRoot) {
    const operatorDir = path.join(stateRoot, 'context', 'operator');
    fs.mkdirSync(operatorDir, { recursive: true });
    fs.writeFileSync(path.join(operatorDir, 'operator-context.normalized.json'), JSON.stringify({
      schema: 'mira.normalized.operator_context.v1',
      business_thesis: 'Mira is James operating extension for CRM, ERP, admin, customer communication, tax, documents, computer-use, and business workflows.',
      operating_lanes: [
        'CRM',
        'ERP',
        'admin',
        'customer communication',
        'tax',
        'documents',
        'computer-use',
        'business workflows',
      ],
      known_product_lanes: ['TrustQuote'],
      explicit_non_claims: [
        'TrustQuote is not proof of the business legal name',
        'do not invent James business name',
      ],
      source_metadata: {
        source_path: 'workspace/knowledge/user-context.md',
        metadata_only: true,
        live_continuity_excluded: true,
        raw_content_included: false,
        normalized_summary_only: true,
      },
    }, null, 2));
  }

  function startOpenAiMock(handler) {
    openAiRequests = [];
    return new Promise((resolve, reject) => {
      openAiMockServer = http.createServer((request, response) => {
        let rawBody = '';
        request.on('data', (chunk) => {
          rawBody += chunk.toString();
        });
        request.on('end', () => {
          const parsedBody = rawBody ? JSON.parse(rawBody) : null;
          openAiRequests.push({
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization,
            body: parsedBody,
          });
          handler(request, response, parsedBody);
        });
      });
      openAiMockServer.once('error', reject);
      openAiMockServer.listen(0, '127.0.0.1', () => {
        const address = openAiMockServer.address();
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  test('returns manual bridge plan without executing send CLI', async () => {
    await startServer();

    const response = await fetch(`${baseUrl}/bridge/manual-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetRole: 'builder',
        content: '(MIRA #1): runtime manual plan API',
        sessionId: 'app-session-373',
        messageId: 'mira-runtime-api-plan-1',
        requestId: 'req-runtime-api-plan-1',
        evidence: [{
          kind: 'file',
          path: 'mira/bridge/squidrun-adapter-protocol-v0.md',
          summary: 'Runtime API manual plan evidence.',
        }],
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_bridge_request_plan.v0',
      manualExecutionRequired: true,
      runtimeExecutes: false,
      target: {
        role: 'builder',
        paneId: '2',
      },
      envelope: expect.objectContaining({
        request_id: 'req-runtime-api-plan-1',
        message_id: 'mira-runtime-api-plan-1',
        session_id: 'app-session-373',
        body: {
          content: '(MIRA #1): runtime manual plan API',
        },
      }),
      command: expect.objectContaining({
        executable: process.execPath,
        args: expect.arrayContaining([
          '--target',
          'builder',
          '--content',
          '(MIRA #1): runtime manual plan API',
        ]),
      }),
    }));
  });

  test('serves the minimal Mira web UI from the runtime', async () => {
    await startServer();

    const indexResponse = await fetch(`${baseUrl}/`);
    const indexHtml = await indexResponse.text();
    const appResponse = await fetch(`${baseUrl}/app.js`);
    const appJs = await appResponse.text();
    const cssResponse = await fetch(`${baseUrl}/styles.css`);
    const css = await cssResponse.text();

    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get('content-type')).toContain('text/html');
    expect(indexHtml).toContain('<h1>Mira</h1>');
    expect(indexHtml).toContain('id="turnForm"');
    expect(indexHtml).toContain('id="contextPanel"');
    expect(indexHtml).toContain('id="brainLine"');
    expect(indexHtml).toContain('id="reviewSummary"');
    expect(indexHtml).toContain('id="modelSummary"');
    expect(indexHtml).toContain('id="personaSummary"');
    expect(indexHtml).toContain('id="modelProviderSelect"');
    expect(indexHtml).toContain('id="recentSummary"');
    expect(indexHtml).toContain('id="workSummary"');
    expect(indexHtml).toContain('class="workbench-head"');
    expect(indexHtml).toContain('class="workbench-section"');
    expect(indexHtml).toContain('id="draftButton"');
    expect(indexHtml).toContain('id="draftList"');
    expect(indexHtml).toContain('id="taskList"');
    expect(indexHtml).toContain('id="reviewPanel"');
    expect(indexHtml).toContain('id="readyList"');
    expect(indexHtml).toContain('Ready');
    expect(indexHtml).toContain('id="sendPacketList"');
    expect(indexHtml).toContain('Send prep');
    expect(indexHtml).toContain('id="sendConfirmationList"');
    expect(indexHtml).toContain('Confirmations');
    expect(indexHtml).toContain('id="sendCheckList"');
    expect(indexHtml).toContain('Pre-send checks');
    expect(indexHtml).toContain('id="routeRequestList"');
    expect(indexHtml).toContain('id="routeContinuationPanel"');
    expect(indexHtml).toContain('id="routeContinuationList"');
    expect(indexHtml).toContain('id="autonomyTickButton"');
    expect(indexHtml).toContain('id="autonomyFollowButton"');
    expect(indexHtml).toContain('id="autonomyList"');
    expect(indexHtml).toContain('Autonomy');
    expect(indexHtml).toContain('id="recentTurns"');
    expect(indexHtml).toContain('Mira.</p>');
    expect(indexHtml).not.toContain('Mira Runtime');
    expect(indexHtml).not.toContain('business mess');
    expect(appResponse.status).toBe(200);
    expect(appResponse.headers.get('content-type')).toContain('text/javascript');
    expect(appJs).toContain("fetch('/turn'");
    expect(appJs).toContain("fetch('/model/status'");
    expect(appJs).toContain("fetch('/model/providers'");
    expect(appJs).toContain('modelProviderSelect');
    expect(appJs).toContain('modelProvider');
    expect(appJs).toContain('syncWorkbenchForViewport');
    expect(appJs).toContain("window.matchMedia('(max-width: 820px)')");
    expect(appJs).toContain("fetch('/work/drafts'");
    expect(appJs).toContain("fetch('/work/tasks'");
    expect(appJs).toContain('cleanPreviewText');
    expect(appJs).toContain('requestPreview');
    expect(appJs).toContain('taskPreview');
    expect(appJs).toContain('sourceDraftToken');
    expect(appJs).toContain("fetch('/work/task-review'");
    expect(appJs).toContain("fetch('/work/ready'");
    expect(appJs).toContain("fetch('/work/send-packets'");
    expect(appJs).toContain("fetch('/work/send-confirmations'");
    expect(appJs).toContain("fetch('/work/send-checks'");
    expect(appJs).toContain("fetch('/mission-control/route-previews'");
    expect(appJs).toContain("fetch('/mission-control/internal-route-requests'");
    expect(appJs).toContain("fetch('/mission-control/owned-work-continuations'");
    expect(appJs).toContain("fetch('/mission-control/follow-through-recommendations'");
    expect(appJs).toContain("fetch('/mission-control/internal-delivery-previews'");
    expect(appJs).toContain("fetch('/mission-control/dispatch-readiness'");
    expect(appJs).toContain("fetch('/mission-control/internal-send-dry-runs'");
    expect(appJs).toContain("fetch('/mission-control/internal-send-activation-designs'");
    expect(appJs).toContain("fetch('/mission-control/internal-send-activation-requests'");
    expect(appJs).toContain("fetch('/mission-control/internal-send-activation-decision-audits'");
    expect(appJs).toContain("fetch('/mission-control/internal-send-activation-implementation-readiness'");
    expect(appJs).toContain('Save preview for review');
    expect(appJs).toContain('Make review item');
    expect(appJs).toContain('review continuation');
    expect(appJs).toContain('Preview delivery packet');
    expect(appJs).toContain('Review dispatch readiness');
    expect(appJs).toContain('Create send dry run');
    expect(appJs).toContain('Design activation proof');
    expect(indexHtml).toContain('id="routeFollowThroughList"');
    expect(indexHtml).toContain('id="routeDeliveryPreviewList"');
    expect(indexHtml).toContain('id="routeDispatchReadinessList"');
    expect(indexHtml).toContain('id="routeInternalSendDryRunList"');
    expect(indexHtml).toContain('id="routeInternalSendActivationDesignList"');
    expect(indexHtml).toContain('id="routeInternalSendActivationRequestList"');
    expect(indexHtml).toContain('id="routeInternalSendActivationAuditList"');
    expect(indexHtml).toContain('id="routeInternalSendActivationReadinessList"');
    expect(appJs).toContain("fetch('/autonomy/status'");
    expect(appJs).toContain("fetch('/autonomy/tick'");
    expect(appJs).toContain("fetch('/autonomy/follow-through'");
    expect(appJs).toContain('Run local tick');
    expect(appJs).toContain('Follow through');
    expect(appJs).toContain('Copy text');
    expect(appJs).toContain('Prepare send packet');
    expect(appJs).toContain('Confirm manually');
    expect(appJs).toContain('confirmed manually');
    expect(appJs).toContain('Run pre-send check');
    expect(appJs).toContain('still not sent');
    expect(appJs).toContain('not sent');
    expect(appJs).toContain('workSendConfirmationCount');
    expect(appJs).toContain('workSendCheckCount');
    expect(appJs).toContain('autonomyQueueCount');
    expect(appJs).toContain('autonomyFollowThroughCount');
    expect(appJs).toContain('autonomyLoopLabel');
    expect(appJs).toContain('Loop');
    expect(appJs).toContain('readyCount');
    expect(appJs).toContain('submitTaskReview');
    expect(appJs).toContain("fetch('/conversation/memory'");
    expect(appJs).toContain('formatRecentMemoryForDisplay');
    expect(appJs).toContain('Answer quality has been the pressure point');
    expect(appJs).toContain('brainLine');
    expect(appJs).toContain("fetch('/voice/correction'");
    expect(appJs).toContain("fetch('/voice/corrections'");
    expect(appJs).toContain('wrong shape');
    expect(appJs).toContain('turnMetadata');
    expect(appJs).toContain('personaCore');
    expect(appJs).toContain('recentMemory');
    expect(appJs).toContain('mira.turn_quality_capture_metadata.v0');
    expect(appJs).toContain('contextToggle');
    expect(appJs).toContain('syncWorkbenchForViewport');
    expect(appJs).toContain("window.matchMedia('(max-width: 820px)')");
    expect(appJs).toContain('useModel');
    expect(appJs).toContain("event.key !== 'Enter'");
    expect(appJs).toContain('event.shiftKey');
    expect(appJs).toContain('event.isComposing');
    expect(appJs).toContain('requestSubmit');
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toContain('text/css');
    expect(css).toContain('.conversation');
    expect(css).toContain('.context-panel');
    expect(css).toContain('.brain-line');
    expect(css).toContain('.subtle-button');
    expect(css).toContain('.draft-item');
    expect(css).toContain('.review-panel-body');
    expect(css).toContain('.review-actions');
    expect(css).toMatch(/body\s*\{[\s\S]*height:\s*100dvh[\s\S]*overflow:\s*hidden/);
    expect(css).toMatch(/\.shell\s*\{[\s\S]*height:\s*100dvh[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/);
    expect(css).toMatch(/\.conversation\s*\{[\s\S]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\) auto[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/);
    expect(css).toContain('.memory-strip');
    expect(css).toContain('.model-picker');
    expect(css).toContain('.workbench-head');
    expect(css).toContain('.workbench-section');
    expect(css).toMatch(/\.thread\s*\{[\s\S]*min-height:\s*0[\s\S]*overflow-y:\s*auto/);
    expect(css).toMatch(/textarea\s*\{[\s\S]*resize:\s*none[\s\S]*overflow-y:\s*auto/);
    expect(css).not.toMatch(/@media\s*\(max-width:\s*820px\)\s*\{[\s\S]*body\s*\{[\s\S]*overflow:\s*auto/);
    expect(css).not.toContain('.side');
  });

  test('runs local autonomy tick and follow-through with no external action', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-autonomy-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const emptyStatusResponse = await fetch(`${baseUrl}/autonomy/status`);
    const emptyStatus = await emptyStatusResponse.json();
    const tickResponse = await fetch(`${baseUrl}/autonomy/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const tickPayload = await tickResponse.json();
    const duplicateResponse = await fetch(`${baseUrl}/autonomy/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const duplicatePayload = await duplicateResponse.json();
    const followResponse = await fetch(`${baseUrl}/autonomy/follow-through`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const followPayload = await followResponse.json();
    const duplicateFollowResponse = await fetch(`${baseUrl}/autonomy/follow-through`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const duplicateFollowPayload = await duplicateFollowResponse.json();
    const statusResponse = await fetch(`${baseUrl}/autonomy/status`);
    const statusPayload = await statusResponse.json();

    expect(emptyStatusResponse.status).toBe(200);
    expect(emptyStatus).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.autonomy_status.v0',
      queueCount: 0,
      followThroughCount: 0,
      loop: expect.objectContaining({
        status: 'not_started',
        lastRunAt: null,
      }),
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(tickResponse.status).toBe(200);
    expect(tickPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.autonomy_tick.v0',
      createdCount: 3,
      reusedCount: 0,
      briefWritten: true,
      queueCount: 3,
      followThroughCount: 0,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(tickPayload.policy.localLoopAllowed).toBe(true);
    expect(tickPayload.policy.externalActionsAllowed).toBe(false);
    expect(tickPayload.policy.approvalRequiredFor).toEqual(expect.arrayContaining([
      'customer send',
      'money movement',
      'legal/tax filing',
      'delete or move live data',
    ]));
    expect(tickPayload.queue.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Use recent memory instead of waiting',
      'Follow through on local work queue',
      'Watch agent motion',
    ]));
    expect(tickPayload.queue.every((item) => item.needsJames === false)).toBe(true);
    expect(tickPayload.queue.every((item) => item.nextMove && item.permissionUsed)).toBe(true);
    expect(tickPayload.brief.available).toBe(true);
    expect(tickPayload.brief.lines.join(' ')).toContain('Mira can keep local notes');
    expect(fs.existsSync(path.join(tempStateRoot, 'autonomy', 'standing-permissions.json'))).toBe(true);
    expect(fs.readdirSync(path.join(tempStateRoot, 'autonomy', 'queue')).filter((file) => file.endsWith('.json'))).toHaveLength(3);
    expect(fs.readdirSync(path.join(tempStateRoot, 'autonomy', 'briefs')).filter((file) => file.endsWith('.json'))).toHaveLength(1);

    expect(duplicateResponse.status).toBe(200);
    expect(duplicatePayload.createdCount).toBe(0);
    expect(duplicatePayload.reusedCount).toBe(3);
    expect(duplicatePayload.queueCount).toBe(3);
    expect(followResponse.status).toBe(200);
    expect(followPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.autonomy_follow_through.v0',
      createdCount: 3,
      reusedCount: 0,
      queueCount: 3,
      followThroughCount: 3,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(followPayload.followThrough.map((item) => item.resultTitle)).toEqual(expect.arrayContaining([
      'Carry the thread into the next answer',
      'Advance the local work queue',
      'Keep the Windows team from parking',
    ]));
    expect(followPayload.followThrough.every((item) => item.status === 'local_step_prepared')).toBe(true);
    expect(followPayload.followThrough.every((item) => item.localOnly === true)).toBe(true);
    expect(followPayload.followThrough.every((item) => item.nextVisibleStep && item.evidence.length > 0)).toBe(true);
    expect(fs.readdirSync(path.join(tempStateRoot, 'autonomy', 'follow-through')).filter((file) => file.endsWith('.json'))).toHaveLength(3);
    expect(duplicateFollowResponse.status).toBe(200);
    expect(duplicateFollowPayload.createdCount).toBe(0);
    expect(duplicateFollowPayload.reusedCount).toBe(3);
    expect(duplicateFollowPayload.followThroughCount).toBe(3);
    expect(statusResponse.status).toBe(200);
    expect(statusPayload.queueCount).toBe(3);
    expect(statusPayload.followThroughCount).toBe(3);
    expect(statusPayload.brief.available).toBe(true);
  });

  test('runs the autonomy loop on demand and on the runtime timer', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-autonomy-loop-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const runResponse = await fetch(`${baseUrl}/autonomy/loop/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const runPayload = await runResponse.json();
    const duplicateRunResponse = await fetch(`${baseUrl}/autonomy/loop/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const duplicateRunPayload = await duplicateRunResponse.json();
    const statusResponse = await fetch(`${baseUrl}/autonomy/status`);
    const statusPayload = await statusResponse.json();

    expect(runResponse.status).toBe(200);
    expect(runPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.autonomy_loop_run.v0',
      queueCount: 3,
      followThroughCount: 3,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(runPayload.tick).toEqual(expect.objectContaining({
      createdCount: 3,
      reusedCount: 0,
      briefWritten: true,
    }));
    expect(runPayload.followThroughRun).toEqual(expect.objectContaining({
      createdCount: 3,
      reusedCount: 0,
    }));
    expect(runPayload.loop).toEqual(expect.objectContaining({
      protocol: 'mira.autonomy_loop_status.v0',
      enabled: true,
      status: 'ran',
      source: 'manual',
      tickCreatedCount: 3,
      followCreatedCount: 3,
      queueCount: 3,
      followThroughCount: 3,
    }));
    expect(typeof runPayload.loop.lastRunAt).toBe('string');
    expect(fs.existsSync(path.join(tempStateRoot, 'autonomy', 'loop-status.json'))).toBe(true);
    expect(duplicateRunResponse.status).toBe(200);
    expect(duplicateRunPayload.tick.reusedCount).toBe(3);
    expect(duplicateRunPayload.followThroughRun.reusedCount).toBe(3);
    expect(statusResponse.status).toBe(200);
    expect(statusPayload.loop.status).toBe('ran');
    expect(statusPayload.loop.source).toBe('manual');

    await new Promise((resolve) => {
      serverProcess.once('close', resolve);
      serverProcess.kill();
    });
    serverProcess = null;
    fs.rmSync(tempStateRoot, { recursive: true, force: true });
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-autonomy-loop-timer-'));
    await startServer({
      MIRA_STATE_ROOT: tempStateRoot,
      MIRA_AUTONOMY_LOOP: 'on',
      MIRA_AUTONOMY_LOOP_STARTUP_DELAY_MS: '10',
      MIRA_AUTONOMY_LOOP_INTERVAL_MS: '60000',
    });
    const timerStatus = await waitForAutonomyLoopStatus();
    expect(timerStatus.queueCount).toBe(3);
    expect(timerStatus.followThroughCount).toBe(3);
    expect(timerStatus.loop).toEqual(expect.objectContaining({
      status: 'ran',
      source: 'timer',
      queueCount: 3,
      followThroughCount: 3,
    }));
    expect(typeof timerStatus.loop.nextRunAt).toBe('string');
  });

  test('saves Mission Control route previews as local review history only', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-mission-route-preview-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const preview = {
      status: 'reviewed_preview_only',
      selectedDraftTarget: 'oracle',
      selectedDraftPurpose: 'benchmark review',
      plan: {
        ok: true,
        protocol: 'mira.runtime_bridge_request_plan.v0',
        manualExecutionRequired: true,
        runtimeExecutes: false,
        target: {
          role: 'oracle',
          paneId: '3',
        },
        envelope: {
          protocol: 'mira.hm_send_adapter.v0',
          request_id: 'req-mission-route-preview-test',
          message_id: 'mission-route-preview-test',
          session_id: null,
          source: {
            service: 'mira-runtime',
            surface: 'runtime-manual-bridge-planner',
          },
          target: {
            system: 'squidrun',
            role: 'oracle',
            pane_id: '3',
          },
          evidence: [{
            kind: 'file',
            path: 'docs/mira-system-map.md',
            summary: 'Mission Control route-preview persistence proof.',
          }],
          body: {
            content: 'Challenge the saved Mission Control route preview against the benchmark.',
          },
        },
        command: {
          executable: process.execPath,
          args: ['mira/bridge/send-pane-message.js', '--target', 'oracle'],
          cwd: repoRoot,
        },
      },
      audit: {
        reviewStatus: 'preview_ready',
        sendPerformed: false,
        runtimeExecutes: false,
        externalSend: false,
        routeFlip: false,
        providerInvoked: false,
        note: 'Preview only; no send invoked.',
      },
    };

    const emptyResponse = await fetch(`${baseUrl}/mission-control/route-previews`);
    const emptyPayload = await emptyResponse.json();
    const saveResponse = await fetch(`${baseUrl}/mission-control/route-previews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        preview,
        missionAnswer: 'Project/lane: squidrun / architect#280.\nJAMES ACTION: NONE - local preview persistence.',
        source: 'runtime-ui-test',
      }),
    });
    const savePayload = await saveResponse.json();
    const duplicateResponse = await fetch(`${baseUrl}/mission-control/route-previews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        preview,
        missionAnswer: 'Project/lane: squidrun / architect#280.\nJAMES ACTION: NONE - local preview persistence.',
        source: 'runtime-ui-test',
      }),
    });
    const duplicatePayload = await duplicateResponse.json();
    const listResponse = await fetch(`${baseUrl}/mission-control/route-previews?includeInternal=1`);
    const listPayload = await listResponse.json();

    expect(emptyResponse.status).toBe(200);
    expect(emptyPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_route_preview_list.v0',
      previewCount: 0,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));
    expect(saveResponse.status).toBe(200);
    expect(savePayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_route_preview_write.v0',
      created: true,
      stateRootPath: path.resolve(tempStateRoot),
      relativePath: expect.stringMatching(/^mission-control\/route-previews\/mission-route-preview-.*\.json$/),
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
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
    }));
    expect(savePayload.record).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_route_preview.v0',
      status: 'pending_internal_review',
      source: 'runtime-ui-test',
      targetRole: 'oracle',
      targetPaneId: '3',
      purpose: 'benchmark review',
      contentPreview: 'Challenge the saved Mission Control route preview against the benchmark.',
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
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
    }));
    expect(savePayload.record).not.toHaveProperty('command');
    expect(savePayload.record).not.toHaveProperty('args');
    expect(savePayload.record.content).toContain('Challenge the saved Mission Control route preview');
    expect(savePayload.record.missionAnswerPreview).toContain('Project/lane: squidrun / architect#280.');
    expect(fs.existsSync(savePayload.absolutePath)).toBe(true);
    const savedRecord = JSON.parse(fs.readFileSync(savePayload.absolutePath, 'utf8'));
    expect(savedRecord).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_route_preview.v0',
      status: 'pending_internal_review',
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));
    expect(savedRecord).not.toHaveProperty('command');
    expect(savedRecord).not.toHaveProperty('args');
    expect(duplicateResponse.status).toBe(200);
    expect(duplicatePayload.created).toBe(false);
    expect(duplicatePayload.relativePath).toBe(savePayload.relativePath);
    for (const flag of ['telegramSend', 'accountOrTokenAccess', 'liveHmSend']) {
      const blockedPreview = JSON.parse(JSON.stringify(preview));
      blockedPreview.audit[flag] = true;
      blockedPreview.plan.envelope.message_id = `mission-route-preview-blocked-${flag}`;
      blockedPreview.plan.envelope.request_id = `req-mission-route-preview-blocked-${flag}`;
      blockedPreview.plan.envelope.body.content = `This preview tries to set ${flag} true.`;
      const blockedResponse = await fetch(`${baseUrl}/mission-control/route-previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          preview: blockedPreview,
          missionAnswer: 'Project/lane: squidrun / architect#295.\nJAMES ACTION: NONE - blocked preview regression.',
          source: 'runtime-ui-test',
        }),
      });
      const blockedPayload = await blockedResponse.json();
      expect(blockedResponse.status).toBe(400);
      expect(blockedPayload.error).toEqual(expect.objectContaining({
        code: 'route_preview_has_live_effect',
        message: expect.stringContaining(`audit.${flag}`),
      }));
      expect(fs.readdirSync(path.join(tempStateRoot, 'mission-control', 'route-previews')).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    expect(listResponse.status).toBe(200);
    expect(listPayload.previewCount).toBe(1);
    expect(listPayload.previews[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^mission-route-/),
      status: 'pending_internal_review',
      relativePath: savePayload.relativePath,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      routeFlip: false,
      providerInvoked: false,
    }));
    expect(fs.readdirSync(path.join(tempStateRoot, 'mission-control', 'route-previews')).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  });

  test('promotes saved Mission Control route previews into internal route requests only', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-mission-route-request-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const preview = {
      status: 'reviewed_preview_only',
      selectedDraftTarget: 'oracle',
      selectedDraftPurpose: 'benchmark review',
      plan: {
        ok: true,
        protocol: 'mira.runtime_bridge_request_plan.v0',
        manualExecutionRequired: true,
        runtimeExecutes: false,
        target: {
          role: 'oracle',
          paneId: '3',
        },
        envelope: {
          protocol: 'mira.hm_send_adapter.v0',
          request_id: 'req-mission-route-request-test',
          message_id: 'mission-route-request-test',
          session_id: null,
          evidence: [{
            kind: 'file',
            path: 'docs/mira-system-map.md',
            summary: 'Mission Control internal-route request proof.',
          }],
          body: {
            content: 'Review the saved Mission Control route preview and decide the next internal move.',
          },
        },
        command: {
          executable: process.execPath,
          args: ['mira/bridge/send-pane-message.js', '--target', 'oracle'],
          cwd: repoRoot,
        },
      },
      audit: {
        reviewStatus: 'preview_ready',
        sendPerformed: false,
        runtimeExecutes: false,
        externalSend: false,
        routeFlip: false,
        providerInvoked: false,
        telegramSend: false,
        accountOrTokenAccess: false,
        liveHmSend: false,
        note: 'Preview only; no send invoked.',
      },
    };

    const routeRequestToken = (id) => `mission-route-${crypto.createHash('sha256')
      .update(`mira.mission_control_route_preview.v0:${id}`)
      .digest('base64url')
      .slice(0, 18)}`;
    const routeRequestDir = path.join(tempStateRoot, 'mission-control', 'internal-route-requests');
    const saveResponse = await fetch(`${baseUrl}/mission-control/route-previews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        preview,
        missionAnswer: 'Project/lane: squidrun / architect#298.\nJAMES ACTION: NONE - local request promotion.',
        source: 'runtime-ui-test',
      }),
    });
    const savePayload = await saveResponse.json();
    const emptyRequestResponse = await fetch(`${baseUrl}/mission-control/internal-route-requests`);
    const emptyRequestPayload = await emptyRequestResponse.json();
    const missingTokenResponse = await fetch(`${baseUrl}/mission-control/internal-route-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const missingTokenPayload = await missingTokenResponse.json();
    const badTokenResponse = await fetch(`${baseUrl}/mission-control/internal-route-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previewToken: 'mission-route-not-saved' }),
    });
    const badTokenPayload = await badTokenResponse.json();
    const createRequestResponse = await fetch(`${baseUrl}/mission-control/internal-route-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        previewToken: savePayload.record.actionToken,
      }),
    });
    const createRequestPayload = await createRequestResponse.json();
    const duplicateRequestResponse = await fetch(`${baseUrl}/mission-control/internal-route-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        previewToken: savePayload.record.actionToken,
      }),
    });
    const duplicateRequestPayload = await duplicateRequestResponse.json();
    const listRequestResponse = await fetch(`${baseUrl}/mission-control/internal-route-requests?includeInternal=1`);
    const listRequestPayload = await listRequestResponse.json();

    expect(saveResponse.status).toBe(200);
    expect(emptyRequestResponse.status).toBe(200);
    expect(emptyRequestPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_route_request_list.v0',
      requestCount: 0,
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
    }));
    expect(missingTokenResponse.status).toBe(400);
    expect(missingTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_route_preview_token_required',
    }));
    expect(badTokenResponse.status).toBe(400);
    expect(badTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_route_preview_not_found',
    }));
    expect(createRequestResponse.status).toBe(200);
    expect(createRequestPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_route_request_write.v0',
      created: true,
      stateRootPath: path.resolve(tempStateRoot),
      relativePath: expect.stringMatching(/^mission-control\/internal-route-requests\/mission-route-request-.*\.json$/),
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
    }));
    expect(createRequestPayload.request).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_route_request.v0',
      status: 'pending_internal_review',
      sourcePreviewId: savePayload.record.id,
      sourcePreviewToken: savePayload.record.actionToken,
      targetRole: 'oracle',
      targetPaneId: '3',
      purpose: 'benchmark review',
      contentPreview: 'Review the saved Mission Control route preview and decide the next internal move.',
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
    }));
    expect(createRequestPayload.request).not.toHaveProperty('command');
    expect(createRequestPayload.request).not.toHaveProperty('args');
    expect(fs.existsSync(createRequestPayload.absolutePath)).toBe(true);
    const storedRequest = JSON.parse(fs.readFileSync(createRequestPayload.absolutePath, 'utf8'));
    expect(storedRequest).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_route_request.v0',
      status: 'pending_internal_review',
      sourcePreviewToken: savePayload.record.actionToken,
      reviewableOwnedWork: true,
      manualExecutionRequired: true,
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
    }));
    expect(storedRequest).not.toHaveProperty('command');
    expect(storedRequest).not.toHaveProperty('args');
    expect(duplicateRequestResponse.status).toBe(200);
    expect(duplicateRequestPayload.created).toBe(false);
    expect(duplicateRequestPayload.relativePath).toBe(createRequestPayload.relativePath);
    for (const input of [
      { previewToken: savePayload.record.actionToken, telegramSend: true },
      { previewToken: savePayload.record.actionToken, audit: { accountOrTokenAccess: true } },
      { previewToken: savePayload.record.actionToken, plan: { liveHmSend: true } },
    ]) {
      const blockedRequestResponse = await fetch(`${baseUrl}/mission-control/internal-route-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedRequestPayload = await blockedRequestResponse.json();
      expect(blockedRequestResponse.status).toBe(400);
      expect(blockedRequestPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_route_request_has_live_effect',
      }));
      expect(fs.readdirSync(routeRequestDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    for (const input of [
      { previewToken: savePayload.record.actionToken, command: { executable: process.execPath } },
      { previewToken: savePayload.record.actionToken, args: ['hm-send', 'oracle'] },
    ]) {
      const blockedCommandResponse = await fetch(`${baseUrl}/mission-control/internal-route-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedCommandPayload = await blockedCommandResponse.json();
      expect(blockedCommandResponse.status).toBe(400);
      expect(blockedCommandPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_route_request_command_not_allowed',
      }));
      expect(fs.readdirSync(routeRequestDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    expect(listRequestResponse.status).toBe(200);
    expect(listRequestPayload.requestCount).toBe(1);
    expect(listRequestPayload.requests[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^mission-request-/),
      status: 'pending_internal_review',
      relativePath: createRequestPayload.relativePath,
      reviewableOwnedWork: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));

    const continuationDir = path.join(tempStateRoot, 'mission-control', 'owned-work-continuations');
    const emptyContinuationResponse = await fetch(`${baseUrl}/mission-control/owned-work-continuations`);
    const emptyContinuationPayload = await emptyContinuationResponse.json();
    const emptyRecommendationResponse = await fetch(`${baseUrl}/mission-control/follow-through-recommendations`);
    const emptyRecommendationPayload = await emptyRecommendationResponse.json();
    const emptyDeliveryPreviewResponse = await fetch(`${baseUrl}/mission-control/internal-delivery-previews`);
    const emptyDeliveryPreviewPayload = await emptyDeliveryPreviewResponse.json();
    const emptyDispatchReadinessResponse = await fetch(`${baseUrl}/mission-control/dispatch-readiness`);
    const emptyDispatchReadinessPayload = await emptyDispatchReadinessResponse.json();
    const emptyInternalSendDryRunResponse = await fetch(`${baseUrl}/mission-control/internal-send-dry-runs`);
    const emptyInternalSendDryRunPayload = await emptyInternalSendDryRunResponse.json();
    const emptyActivationDesignResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-designs`);
    const emptyActivationDesignPayload = await emptyActivationDesignResponse.json();
    const emptyActivationRequestResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-requests`);
    const emptyActivationRequestPayload = await emptyActivationRequestResponse.json();
    const emptyActivationDecisionAuditResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-decision-audits`);
    const emptyActivationDecisionAuditPayload = await emptyActivationDecisionAuditResponse.json();
    const emptyActivationImplementationReadinessResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-implementation-readiness`);
    const emptyActivationImplementationReadinessPayload = await emptyActivationImplementationReadinessResponse.json();
    const missingContinuationTokenResponse = await fetch(`${baseUrl}/mission-control/owned-work-continuations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const missingContinuationTokenPayload = await missingContinuationTokenResponse.json();
    const badContinuationTokenResponse = await fetch(`${baseUrl}/mission-control/owned-work-continuations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestToken: 'mission-request-not-saved', decision: 'approve' }),
    });
    const badContinuationTokenPayload = await badContinuationTokenResponse.json();
    const approveContinuationResponse = await fetch(`${baseUrl}/mission-control/owned-work-continuations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestToken: createRequestPayload.request.actionToken,
        decision: 'approve',
        note: 'Approved as a review-only owned-work continuation.',
      }),
    });
    const approveContinuationPayload = await approveContinuationResponse.json();
    const editContinuationResponse = await fetch(`${baseUrl}/mission-control/owned-work-continuations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestToken: createRequestPayload.request.actionToken,
        decision: 'edit',
        editedContent: 'Edited internal continuation for Oracle review.',
        note: 'Edited locally before review.',
      }),
    });
    const editContinuationPayload = await editContinuationResponse.json();
    const rejectContinuationResponse = await fetch(`${baseUrl}/mission-control/owned-work-continuations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestToken: createRequestPayload.request.actionToken,
        decision: 'reject',
        note: 'Rejected as the wrong next move.',
      }),
    });
    const rejectContinuationPayload = await rejectContinuationResponse.json();
    const duplicateEditContinuationResponse = await fetch(`${baseUrl}/mission-control/owned-work-continuations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestToken: createRequestPayload.request.actionToken,
        decision: 'edit',
        editedContent: 'Edited internal continuation for Oracle review.',
        note: 'Edited locally before review.',
      }),
    });
    const duplicateEditContinuationPayload = await duplicateEditContinuationResponse.json();
    const listContinuationResponse = await fetch(`${baseUrl}/mission-control/owned-work-continuations?includeInternal=1`);
    const listContinuationPayload = await listContinuationResponse.json();

    expect(emptyContinuationResponse.status).toBe(200);
    expect(emptyContinuationPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_owned_work_continuation_list.v0',
      continuationCount: 0,
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
    }));
    expect(emptyRecommendationResponse.status).toBe(200);
    expect(emptyRecommendationPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_follow_through_recommendation_list.v0',
      recommendationCount: 0,
      selectedRecommendation: null,
      recommendations: [],
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
    }));
    expect(emptyDeliveryPreviewResponse.status).toBe(200);
    expect(emptyDeliveryPreviewPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_delivery_preview_list.v0',
      previewCount: 0,
      previews: [],
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
    }));
    expect(emptyDispatchReadinessResponse.status).toBe(200);
    expect(emptyDispatchReadinessPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_dispatch_readiness_list.v0',
      readinessCount: 0,
      readiness: [],
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
    }));
    expect(emptyInternalSendDryRunResponse.status).toBe(200);
    expect(emptyInternalSendDryRunPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_dry_run_list.v0',
      dryRunCount: 0,
      dryRuns: [],
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
    }));
    expect(emptyActivationDesignResponse.status).toBe(200);
    expect(emptyActivationDesignPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_design_list.v0',
      designCount: 0,
      designs: [],
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
    }));
    expect(emptyActivationRequestResponse.status).toBe(200);
    expect(emptyActivationRequestPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_request_preview_list.v0',
      requestCount: 0,
      requests: [],
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
    }));
    expect(emptyActivationDecisionAuditResponse.status).toBe(200);
    expect(emptyActivationDecisionAuditPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_decision_audit_list.v0',
      auditCount: 0,
      audits: [],
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
    }));
    expect(emptyActivationImplementationReadinessResponse.status).toBe(200);
    expect(emptyActivationImplementationReadinessPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_implementation_readiness_list.v0',
      readinessCount: 0,
      readiness: [],
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
    }));
    expect(missingContinuationTokenResponse.status).toBe(400);
    expect(missingContinuationTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_route_request_token_required',
    }));
    expect(badContinuationTokenResponse.status).toBe(400);
    expect(badContinuationTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_route_request_not_found',
    }));
    expect(approveContinuationResponse.status).toBe(200);
    expect(approveContinuationPayload.continuation).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_owned_work_continuation.v0',
      status: 'approved_for_internal_review',
      decision: 'approve',
      sourceRequestId: createRequestPayload.request.id,
      sourceRequestToken: createRequestPayload.request.actionToken,
      sourcePreviewId: savePayload.record.id,
      reviewableOwnedWork: true,
      manualExecutionRequired: true,
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
    }));
    expect(editContinuationResponse.status).toBe(200);
    expect(editContinuationPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_owned_work_continuation_write.v0',
      created: true,
      stateRootPath: path.resolve(tempStateRoot),
      relativePath: expect.stringMatching(/^mission-control\/owned-work-continuations\/mission-owned-work-continuation-.*\.json$/),
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
    }));
    expect(editContinuationPayload.continuation).toEqual(expect.objectContaining({
      status: 'edited_for_internal_review',
      decision: 'edit',
      content: 'Edited internal continuation for Oracle review.',
      editedContent: 'Edited internal continuation for Oracle review.',
      note: 'Edited locally before review.',
      sourceRequestToken: createRequestPayload.request.actionToken,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));
    expect(rejectContinuationResponse.status).toBe(200);
    expect(rejectContinuationPayload.continuation).toEqual(expect.objectContaining({
      status: 'rejected',
      decision: 'reject',
      note: 'Rejected as the wrong next move.',
      notSent: true,
      commandStored: false,
    }));
    expect(editContinuationPayload.continuation).not.toHaveProperty('command');
    expect(editContinuationPayload.continuation).not.toHaveProperty('args');
    expect(fs.existsSync(editContinuationPayload.absolutePath)).toBe(true);
    const storedContinuation = JSON.parse(fs.readFileSync(editContinuationPayload.absolutePath, 'utf8'));
    expect(storedContinuation).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_owned_work_continuation.v0',
      status: 'edited_for_internal_review',
      decision: 'edit',
      editedContent: 'Edited internal continuation for Oracle review.',
      sourceRequestToken: createRequestPayload.request.actionToken,
      manualExecutionRequired: true,
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
    }));
    expect(storedContinuation).not.toHaveProperty('command');
    expect(storedContinuation).not.toHaveProperty('args');
    expect(duplicateEditContinuationResponse.status).toBe(200);
    expect(duplicateEditContinuationPayload.created).toBe(false);
    expect(duplicateEditContinuationPayload.relativePath).toBe(editContinuationPayload.relativePath);
    expect(listContinuationResponse.status).toBe(200);
    expect(listContinuationPayload.continuationCount).toBe(3);
    expect(listContinuationPayload.continuations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionToken: expect.stringMatching(/^mission-continuation-/),
        relativePath: editContinuationPayload.relativePath,
        status: 'edited_for_internal_review',
        decision: 'edit',
        commandStored: false,
        sendPerformed: false,
        runtimeExecutes: false,
        externalSend: false,
        telegramSend: false,
        routeFlip: false,
        providerInvoked: false,
        accountOrTokenAccess: false,
        liveHmSend: false,
      }),
    ]));
    const followThroughResponse = await fetch(`${baseUrl}/mission-control/follow-through-recommendations?includeInternal=1`);
    const followThroughPayload = await followThroughResponse.json();
    expect(followThroughResponse.status).toBe(200);
    expect(followThroughPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_follow_through_recommendation_list.v0',
      stateRootPath: path.resolve(tempStateRoot),
      recommendationCount: 3,
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
    }));
    expect(followThroughPayload.selectedRecommendation).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_follow_through_recommendation.v0',
      status: 'selected_for_internal_review',
      selected: true,
      sourceContinuationId: editContinuationPayload.continuation.id,
      sourceContinuationToken: editContinuationPayload.continuation.actionToken,
      sourceContinuationDecision: 'edit',
      sourceContinuationStatus: 'edited_for_internal_review',
      sourceRequestId: createRequestPayload.request.id,
      targetRole: 'oracle',
      targetPaneId: '3',
      nextTeamMove: 'Ask oracle to review the edit benchmark review continuation: Edited internal continuation for Oracle review.',
      contentPreview: 'Edited internal continuation for Oracle review.',
      note: 'Edited locally before review.',
      selectorReason: 'Newest approved or edited continuation; use this as the next internal team move.',
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
    }));
    expect(followThroughPayload.selectedRecommendation).not.toHaveProperty('command');
    expect(followThroughPayload.selectedRecommendation).not.toHaveProperty('args');
    const rejectedRecommendation = followThroughPayload.recommendations.find((recommendation) => {
      return recommendation.sourceContinuationId === rejectContinuationPayload.continuation.id;
    });
    expect(rejectedRecommendation).toEqual(expect.objectContaining({
      status: 'not_recommended',
      selected: false,
      sourceContinuationDecision: 'reject',
      selectorReason: 'Rejected continuation is retained as history and is not selected.',
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
    }));
    expect(followThroughPayload.recommendations.filter((recommendation) => recommendation.selected === true)).toHaveLength(1);
    const deliveryPreviewDir = path.join(tempStateRoot, 'mission-control', 'internal-delivery-previews');
    const missingDeliveryTokenResponse = await fetch(`${baseUrl}/mission-control/internal-delivery-previews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const missingDeliveryTokenPayload = await missingDeliveryTokenResponse.json();
    const rejectedRecommendationToken = rejectedRecommendation.actionToken;
    const rejectedDeliveryPreviewResponse = await fetch(`${baseUrl}/mission-control/internal-delivery-previews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recommendationToken: rejectedRecommendationToken }),
    });
    const rejectedDeliveryPreviewPayload = await rejectedDeliveryPreviewResponse.json();
    const deliveryPreviewResponse = await fetch(`${baseUrl}/mission-control/internal-delivery-previews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recommendationToken: followThroughPayload.selectedRecommendation.actionToken,
      }),
    });
    const deliveryPreviewPayload = await deliveryPreviewResponse.json();
    const duplicateDeliveryPreviewResponse = await fetch(`${baseUrl}/mission-control/internal-delivery-previews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recommendationToken: followThroughPayload.selectedRecommendation.actionToken,
      }),
    });
    const duplicateDeliveryPreviewPayload = await duplicateDeliveryPreviewResponse.json();
    const listDeliveryPreviewResponse = await fetch(`${baseUrl}/mission-control/internal-delivery-previews?includeInternal=1`);
    const listDeliveryPreviewPayload = await listDeliveryPreviewResponse.json();

    expect(missingDeliveryTokenResponse.status).toBe(400);
    expect(missingDeliveryTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_follow_through_recommendation_token_required',
    }));
    expect(rejectedDeliveryPreviewResponse.status).toBe(400);
    expect(rejectedDeliveryPreviewPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_follow_through_recommendation_not_selected',
    }));
    expect(deliveryPreviewResponse.status).toBe(200);
    expect(deliveryPreviewPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_delivery_preview_write.v0',
      created: true,
      stateRootPath: path.resolve(tempStateRoot),
      relativePath: expect.stringMatching(/^mission-control\/internal-delivery-previews\/mission-delivery-preview-.*\.json$/),
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
    }));
    expect(deliveryPreviewPayload.preview).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_delivery_preview.v0',
      status: 'reviewed_preview_only',
      sourceRecommendationId: followThroughPayload.selectedRecommendation.id,
      sourceRecommendationToken: followThroughPayload.selectedRecommendation.actionToken,
      sourceContinuationId: editContinuationPayload.continuation.id,
      targetRole: 'oracle',
      targetPaneId: '3',
      purpose: 'benchmark review',
      content: 'Edited internal continuation for Oracle review.',
      nextTeamMove: 'Ask oracle to review the edit benchmark review continuation: Edited internal continuation for Oracle review.',
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
    }));
    expect(deliveryPreviewPayload.preview.deliveryPacket).toEqual({
      protocol: 'mira.mission_control_internal_delivery_preview_packet.v0',
      target: {
        system: 'squidrun',
        role: 'oracle',
        paneId: '3',
      },
      body: {
        content: 'Edited internal continuation for Oracle review.',
      },
    });
    const expectedDeliveryPacketSha256 = crypto.createHash('sha256')
      .update(JSON.stringify(deliveryPreviewPayload.preview.deliveryPacket))
      .digest('hex');
    const expectedDeliveryBodySha256 = crypto.createHash('sha256')
      .update('Edited internal continuation for Oracle review.')
      .digest('hex');
    expect(deliveryPreviewPayload.preview.reviewDetails).toEqual({
      protocol: 'mira.mission_control_internal_delivery_preview_review.v0',
      targetLabel: 'oracle pane 3',
      packetSha256: expectedDeliveryPacketSha256,
      bodySha256: expectedDeliveryBodySha256,
      bodyCharCount: 'Edited internal continuation for Oracle review.'.length,
      copyText: 'Edited internal continuation for Oracle review.',
      copyInstruction: 'Manual copy only: paste this body into oracle pane 3 after review.',
      manualCopyRequired: true,
      previewOnly: true,
      noLiveSend: true,
    });
    expect(deliveryPreviewPayload.preview.audit).toEqual(expect.objectContaining({
      reviewStatus: 'preview_ready',
      manualExecutionRequired: true,
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
    }));
    expect(deliveryPreviewPayload.preview).not.toHaveProperty('command');
    expect(deliveryPreviewPayload.preview).not.toHaveProperty('args');
    expect(deliveryPreviewPayload.preview.deliveryPacket).not.toHaveProperty('command');
    expect(deliveryPreviewPayload.preview.deliveryPacket).not.toHaveProperty('args');
    const storedDeliveryPreview = JSON.parse(fs.readFileSync(deliveryPreviewPayload.absolutePath, 'utf8'));
    expect(storedDeliveryPreview).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_delivery_preview.v0',
      status: 'reviewed_preview_only',
      sourceRecommendationToken: followThroughPayload.selectedRecommendation.actionToken,
      targetRole: 'oracle',
      targetPaneId: '3',
      reviewDetails: expect.objectContaining({
        targetLabel: 'oracle pane 3',
        packetSha256: expectedDeliveryPacketSha256,
        copyText: 'Edited internal continuation for Oracle review.',
        manualCopyRequired: true,
        previewOnly: true,
        noLiveSend: true,
      }),
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
    }));
    expect(storedDeliveryPreview).not.toHaveProperty('command');
    expect(storedDeliveryPreview).not.toHaveProperty('args');
    expect(storedDeliveryPreview.deliveryPacket).not.toHaveProperty('command');
    expect(storedDeliveryPreview.deliveryPacket).not.toHaveProperty('args');
    expect(duplicateDeliveryPreviewResponse.status).toBe(200);
    expect(duplicateDeliveryPreviewPayload.created).toBe(false);
    expect(duplicateDeliveryPreviewPayload.relativePath).toBe(deliveryPreviewPayload.relativePath);
    expect(listDeliveryPreviewResponse.status).toBe(200);
    expect(listDeliveryPreviewPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_delivery_preview_list.v0',
      stateRootPath: path.resolve(tempStateRoot),
      previewCount: 1,
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
    }));
    expect(listDeliveryPreviewPayload.previews[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^mission-delivery-preview-/),
      relativePath: deliveryPreviewPayload.relativePath,
      targetRole: 'oracle',
      targetPaneId: '3',
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));

    const dispatchReadinessDir = path.join(tempStateRoot, 'mission-control', 'dispatch-readiness');
    const missingDispatchTokenResponse = await fetch(`${baseUrl}/mission-control/dispatch-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const missingDispatchTokenPayload = await missingDispatchTokenResponse.json();
    const badDispatchTokenResponse = await fetch(`${baseUrl}/mission-control/dispatch-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryPreviewToken: 'mission-delivery-preview-not-saved' }),
    });
    const badDispatchTokenPayload = await badDispatchTokenResponse.json();
    expect(missingDispatchTokenResponse.status).toBe(400);
    expect(missingDispatchTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_delivery_preview_token_required',
    }));
    expect(fs.existsSync(dispatchReadinessDir)).toBe(false);
    expect(badDispatchTokenResponse.status).toBe(400);
    expect(badDispatchTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_delivery_preview_not_found',
    }));
    expect(fs.existsSync(dispatchReadinessDir)).toBe(false);
    const dispatchReadinessResponse = await fetch(`${baseUrl}/mission-control/dispatch-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken }),
    });
    const dispatchReadinessPayload = await dispatchReadinessResponse.json();
    const duplicateDispatchReadinessResponse = await fetch(`${baseUrl}/mission-control/dispatch-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken }),
    });
    const duplicateDispatchReadinessPayload = await duplicateDispatchReadinessResponse.json();
    const listDispatchReadinessResponse = await fetch(`${baseUrl}/mission-control/dispatch-readiness?includeInternal=1`);
    const listDispatchReadinessPayload = await listDispatchReadinessResponse.json();
    expect(dispatchReadinessResponse.status).toBe(200);
    expect(dispatchReadinessPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_dispatch_readiness_write.v0',
      created: true,
      stateRootPath: path.resolve(tempStateRoot),
      relativePath: expect.stringMatching(/^mission-control\/dispatch-readiness\/mission-dispatch-readiness-.*\.json$/),
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
    }));
    expect(dispatchReadinessPayload.readiness).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_dispatch_readiness.v0',
      status: 'ready_for_manual_dispatch_review',
      sourceDeliveryPreviewId: deliveryPreviewPayload.preview.id,
      sourceDeliveryPreviewToken: deliveryPreviewPayload.preview.actionToken,
      targetRole: 'oracle',
      targetPaneId: '3',
      targetLabel: 'oracle pane 3',
      content: 'Edited internal continuation for Oracle review.',
      packetSha256: expectedDeliveryPacketSha256,
      bodySha256: expectedDeliveryBodySha256,
      copyTextSha256: expectedDeliveryBodySha256,
      checksumMatched: true,
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
    }));
    expect(dispatchReadinessPayload.readiness.copiedPaneMessage).toEqual({
      targetRole: 'oracle',
      targetPaneId: '3',
      body: 'Edited internal continuation for Oracle review.',
      bodySha256: expectedDeliveryBodySha256,
      bodyCharCount: 'Edited internal continuation for Oracle review.'.length,
    });
    expect(dispatchReadinessPayload.readiness.checklist).toEqual([
      expect.objectContaining({ id: 'pane_target_matches', ok: true }),
      expect.objectContaining({ id: 'copied_body_checksum_matches', ok: true }),
      expect.objectContaining({ id: 'manual_review_required', ok: true }),
      expect.objectContaining({ id: 'no_delivery_path', ok: true }),
    ]);
    expect(dispatchReadinessPayload.readiness.audit).toEqual(expect.objectContaining({
      reviewStatus: 'dispatch_readiness_ready',
      manualExecutionRequired: true,
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
      checksumMatched: true,
      noHmSendExecution: true,
      noTelegramSend: true,
      noRouteFlip: true,
      noProviderCall: true,
      noRuntimeExecution: true,
      noExternalDelivery: true,
    }));
    expect(dispatchReadinessPayload.readiness).not.toHaveProperty('command');
    expect(dispatchReadinessPayload.readiness).not.toHaveProperty('args');
    expect(dispatchReadinessPayload.readiness.copiedPaneMessage).not.toHaveProperty('command');
    expect(dispatchReadinessPayload.readiness.copiedPaneMessage).not.toHaveProperty('args');
    const storedDispatchReadiness = JSON.parse(fs.readFileSync(dispatchReadinessPayload.absolutePath, 'utf8'));
    expect(storedDispatchReadiness).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_dispatch_readiness.v0',
      status: 'ready_for_manual_dispatch_review',
      sourceDeliveryPreviewToken: deliveryPreviewPayload.preview.actionToken,
      targetLabel: 'oracle pane 3',
      checksumMatched: true,
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
    }));
    expect(storedDispatchReadiness).not.toHaveProperty('command');
    expect(storedDispatchReadiness).not.toHaveProperty('args');
    expect(storedDispatchReadiness.copiedPaneMessage).not.toHaveProperty('command');
    expect(storedDispatchReadiness.copiedPaneMessage).not.toHaveProperty('args');
    expect(duplicateDispatchReadinessResponse.status).toBe(200);
    expect(duplicateDispatchReadinessPayload.created).toBe(false);
    expect(duplicateDispatchReadinessPayload.relativePath).toBe(dispatchReadinessPayload.relativePath);
    expect(listDispatchReadinessResponse.status).toBe(200);
    expect(listDispatchReadinessPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_dispatch_readiness_list.v0',
      stateRootPath: path.resolve(tempStateRoot),
      readinessCount: 1,
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
    }));
    expect(listDispatchReadinessPayload.readiness[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^mission-dispatch-readiness-/),
      relativePath: dispatchReadinessPayload.relativePath,
      targetRole: 'oracle',
      targetPaneId: '3',
      targetLabel: 'oracle pane 3',
      checksumMatched: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));

    const internalSendDryRunDir = path.join(tempStateRoot, 'mission-control', 'internal-send-dry-runs');
    const missingDryRunTokenResponse = await fetch(`${baseUrl}/mission-control/internal-send-dry-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const missingDryRunTokenPayload = await missingDryRunTokenResponse.json();
    const badDryRunTokenResponse = await fetch(`${baseUrl}/mission-control/internal-send-dry-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dispatchReadinessToken: 'mission-dispatch-readiness-not-saved' }),
    });
    const badDryRunTokenPayload = await badDryRunTokenResponse.json();
    expect(missingDryRunTokenResponse.status).toBe(400);
    expect(missingDryRunTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_dispatch_readiness_token_required',
    }));
    expect(fs.existsSync(internalSendDryRunDir)).toBe(false);
    expect(badDryRunTokenResponse.status).toBe(400);
    expect(badDryRunTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_dispatch_readiness_not_found',
    }));
    expect(fs.existsSync(internalSendDryRunDir)).toBe(false);

    const internalSendDryRunResponse = await fetch(`${baseUrl}/mission-control/internal-send-dry-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken }),
    });
    const internalSendDryRunPayload = await internalSendDryRunResponse.json();
    const duplicateInternalSendDryRunResponse = await fetch(`${baseUrl}/mission-control/internal-send-dry-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken }),
    });
    const duplicateInternalSendDryRunPayload = await duplicateInternalSendDryRunResponse.json();
    const listInternalSendDryRunResponse = await fetch(`${baseUrl}/mission-control/internal-send-dry-runs?includeInternal=1`);
    const listInternalSendDryRunPayload = await listInternalSendDryRunResponse.json();

    expect(internalSendDryRunResponse.status).toBe(200);
    expect(internalSendDryRunPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_dry_run_write.v0',
      created: true,
      stateRootPath: path.resolve(tempStateRoot),
      relativePath: expect.stringMatching(/^mission-control\/internal-send-dry-runs\/mission-send-dry-run-.*\.json$/),
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
    }));
    expect(internalSendDryRunPayload.dryRun).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_send_dry_run.v0',
      status: 'dry_run_ready',
      sourceDispatchReadinessId: dispatchReadinessPayload.readiness.id,
      sourceDispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken,
      sourceDeliveryPreviewToken: deliveryPreviewPayload.preview.actionToken,
      targetRole: 'oracle',
      targetPaneId: '3',
      targetLabel: 'oracle pane 3',
      content: 'Edited internal continuation for Oracle review.',
      bodySha256: expectedDeliveryBodySha256,
      packetSha256: expectedDeliveryPacketSha256,
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
    }));
    expect(internalSendDryRunPayload.dryRun.adapterDryRun).toEqual({
      protocol: 'mira.hm_send_adapter.v0',
      dryRun: true,
      channel: 'hm-send',
      transport: 'ui/scripts/hm-send.js',
      target: {
        system: 'squidrun',
        role: 'oracle',
        pane_id: '3',
      },
      body: {
        content: 'Edited internal continuation for Oracle review.',
      },
    });
    expect(internalSendDryRunPayload.dryRun.activationGate).toEqual({
      protocol: 'mira.mission_control_internal_send_activation_gate.v0',
      required: true,
      requiredReview: 'separate_reviewed_activation',
      realSendAllowed: false,
      liveHmSendExecutionAllowed: false,
    });
    expect(internalSendDryRunPayload.dryRun.audit).toEqual(expect.objectContaining({
      reviewStatus: 'internal_send_dry_run_ready',
      dryRunOnly: true,
      manualExecutionRequired: true,
      realSendRequiresSeparateActivation: true,
      dispatchReadinessChecksumMatched: true,
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
    }));
    expect(internalSendDryRunPayload.dryRun).not.toHaveProperty('command');
    expect(internalSendDryRunPayload.dryRun).not.toHaveProperty('args');
    expect(internalSendDryRunPayload.dryRun.adapterDryRun).not.toHaveProperty('command');
    expect(internalSendDryRunPayload.dryRun.adapterDryRun).not.toHaveProperty('args');
    expect(internalSendDryRunPayload.dryRun).not.toHaveProperty('delivery');
    const storedInternalSendDryRun = JSON.parse(fs.readFileSync(internalSendDryRunPayload.absolutePath, 'utf8'));
    expect(storedInternalSendDryRun).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_send_dry_run.v0',
      status: 'dry_run_ready',
      sourceDispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken,
      targetLabel: 'oracle pane 3',
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
    }));
    expect(storedInternalSendDryRun).not.toHaveProperty('command');
    expect(storedInternalSendDryRun).not.toHaveProperty('args');
    expect(storedInternalSendDryRun.adapterDryRun).not.toHaveProperty('command');
    expect(storedInternalSendDryRun.adapterDryRun).not.toHaveProperty('args');
    expect(duplicateInternalSendDryRunResponse.status).toBe(200);
    expect(duplicateInternalSendDryRunPayload.created).toBe(false);
    expect(duplicateInternalSendDryRunPayload.relativePath).toBe(internalSendDryRunPayload.relativePath);
    expect(listInternalSendDryRunResponse.status).toBe(200);
    expect(listInternalSendDryRunPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_dry_run_list.v0',
      stateRootPath: path.resolve(tempStateRoot),
      dryRunCount: 1,
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
    }));
    expect(listInternalSendDryRunPayload.dryRuns[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^mission-send-dry-run-/),
      relativePath: internalSendDryRunPayload.relativePath,
      targetRole: 'oracle',
      targetPaneId: '3',
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));
    fs.writeFileSync(dispatchReadinessPayload.absolutePath, `${JSON.stringify({
      ...storedDispatchReadiness,
      bodySha256: 'bad-body-sha256',
    }, null, 2)}\n`, 'utf8');
    const mismatchedDryRunResponse = await fetch(`${baseUrl}/mission-control/internal-send-dry-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken }),
    });
    const mismatchedDryRunPayload = await mismatchedDryRunResponse.json();
    fs.writeFileSync(dispatchReadinessPayload.absolutePath, `${JSON.stringify(storedDispatchReadiness, null, 2)}\n`, 'utf8');
    expect(mismatchedDryRunResponse.status).toBe(400);
    expect(mismatchedDryRunPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_dry_run_checksum_mismatch',
    }));
    expect(fs.readdirSync(internalSendDryRunDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    for (const input of [
      { dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken, liveHmSend: true },
      { dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken, audit: { sendPerformed: true } },
      { dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken, activationGate: { realSendAllowed: true } },
      { dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken, adapterDryRun: { target: { telegramSend: true } } },
      { dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken, adapterDryRun: { body: { telegramSend: true } } },
    ]) {
      const blockedDryRunResponse = await fetch(`${baseUrl}/mission-control/internal-send-dry-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedDryRunPayload = await blockedDryRunResponse.json();
      expect(blockedDryRunResponse.status).toBe(400);
      expect(blockedDryRunPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_internal_send_dry_run_has_live_effect',
      }));
      expect(fs.readdirSync(internalSendDryRunDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    for (const input of [
      { dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken, command: 'hm-send oracle' },
      { dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken, adapterDryRun: { args: ['hm-send', 'oracle'] } },
      { dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken, adapterDryRun: { target: { command: 'hm-send oracle' } } },
      { dispatchReadinessToken: dispatchReadinessPayload.readiness.actionToken, adapterDryRun: { body: { command: 'hm-send oracle' } } },
    ]) {
      const blockedCommandDryRunResponse = await fetch(`${baseUrl}/mission-control/internal-send-dry-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedCommandDryRunPayload = await blockedCommandDryRunResponse.json();
      expect(blockedCommandDryRunResponse.status).toBe(400);
      expect(blockedCommandDryRunPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_internal_send_dry_run_command_not_allowed',
      }));
      expect(fs.readdirSync(internalSendDryRunDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }

    const activationDesignDir = path.join(tempStateRoot, 'mission-control', 'internal-send-activation-designs');
    const missingActivationDesignTokenResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-designs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const missingActivationDesignTokenPayload = await missingActivationDesignTokenResponse.json();
    const badActivationDesignTokenResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-designs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendDryRunToken: 'mission-send-dry-run-not-saved' }),
    });
    const badActivationDesignTokenPayload = await badActivationDesignTokenResponse.json();
    expect(missingActivationDesignTokenResponse.status).toBe(400);
    expect(missingActivationDesignTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_dry_run_token_required',
    }));
    expect(fs.existsSync(activationDesignDir)).toBe(false);
    expect(badActivationDesignTokenResponse.status).toBe(400);
    expect(badActivationDesignTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_dry_run_not_found',
    }));
    expect(fs.existsSync(activationDesignDir)).toBe(false);

    const activationDesignResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-designs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken }),
    });
    const activationDesignPayload = await activationDesignResponse.json();
    const duplicateActivationDesignResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-designs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken }),
    });
    const duplicateActivationDesignPayload = await duplicateActivationDesignResponse.json();
    const listActivationDesignResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-designs?includeInternal=1`);
    const listActivationDesignPayload = await listActivationDesignResponse.json();
    const expectedAdapterPacketSha256 = crypto.createHash('sha256')
      .update(JSON.stringify(internalSendDryRunPayload.dryRun.adapterDryRun))
      .digest('hex');

    expect(activationDesignResponse.status).toBe(200);
    expect(activationDesignPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_design_write.v0',
      created: true,
      stateRootPath: path.resolve(tempStateRoot),
      relativePath: expect.stringMatching(/^mission-control\/internal-send-activation-designs\/mission-send-activation-design-.*\.json$/),
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
    }));
    expect(activationDesignPayload.design).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_send_activation_design.v0',
      status: 'activation_design_review_only',
      sourceInternalSendDryRunId: internalSendDryRunPayload.dryRun.id,
      sourceInternalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken,
      targetRole: 'oracle',
      targetPaneId: '3',
      targetLabel: 'oracle pane 3',
      content: 'Edited internal continuation for Oracle review.',
      bodySha256: expectedDeliveryBodySha256,
      adapterPacketSha256: expectedAdapterPacketSha256,
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
    }));
    expect(activationDesignPayload.design.activationDesign).toEqual({
      protocol: 'mira.mission_control_internal_send_activation_design_gate.v0',
      designOnly: true,
      activationAllowed: false,
      requiredReview: 'separate_reviewed_activation',
      refusalRollbackAuditRequired: true,
      liveHmSendExecutionAllowed: false,
      realSendAllowed: false,
    });
    expect(activationDesignPayload.design.refusalRequirements.map((item) => item.id)).toEqual([
      'missing_or_bad_token_refuses',
      'live_effect_input_refuses',
      'command_input_refuses',
      'separate_review_required',
    ]);
    expect(activationDesignPayload.design.rollbackRequirements.map((item) => item.id)).toEqual([
      'pre_activation_snapshot_required',
      'failure_audit_required',
    ]);
    expect(activationDesignPayload.design.auditRequirements.map((item) => item.id)).toEqual([
      'durable_activation_audit_required',
      'transport_result_audit_required',
      'no_command_storage_required',
    ]);
    expect(activationDesignPayload.design.audit).toEqual(expect.objectContaining({
      reviewStatus: 'activation_design_ready',
      dryRunOnly: true,
      designOnly: true,
      manualExecutionRequired: true,
      realSendRequiresSeparateActivation: true,
      sourceDryRunChecksumMatched: true,
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
    }));
    expect(activationDesignPayload.design).not.toHaveProperty('command');
    expect(activationDesignPayload.design).not.toHaveProperty('args');
    expect(activationDesignPayload.design).not.toHaveProperty('delivery');
    const storedActivationDesign = JSON.parse(fs.readFileSync(activationDesignPayload.absolutePath, 'utf8'));
    expect(storedActivationDesign).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_send_activation_design.v0',
      status: 'activation_design_review_only',
      sourceInternalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken,
      targetLabel: 'oracle pane 3',
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
    }));
    expect(storedActivationDesign).not.toHaveProperty('command');
    expect(storedActivationDesign).not.toHaveProperty('args');
    expect(storedActivationDesign).not.toHaveProperty('delivery');
    expect(duplicateActivationDesignResponse.status).toBe(200);
    expect(duplicateActivationDesignPayload.created).toBe(false);
    expect(duplicateActivationDesignPayload.relativePath).toBe(activationDesignPayload.relativePath);
    expect(listActivationDesignResponse.status).toBe(200);
    expect(listActivationDesignPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_design_list.v0',
      stateRootPath: path.resolve(tempStateRoot),
      designCount: 1,
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
    }));
    expect(listActivationDesignPayload.designs[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^mission-send-activation-design-/),
      relativePath: activationDesignPayload.relativePath,
      targetRole: 'oracle',
      targetPaneId: '3',
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));
    fs.writeFileSync(internalSendDryRunPayload.absolutePath, `${JSON.stringify({
      ...storedInternalSendDryRun,
      bodySha256: 'bad-body-sha256',
    }, null, 2)}\n`, 'utf8');
    const mismatchedActivationDesignResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-designs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken }),
    });
    const mismatchedActivationDesignPayload = await mismatchedActivationDesignResponse.json();
    fs.writeFileSync(internalSendDryRunPayload.absolutePath, `${JSON.stringify(storedInternalSendDryRun, null, 2)}\n`, 'utf8');
    expect(mismatchedActivationDesignResponse.status).toBe(400);
    expect(mismatchedActivationDesignPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_activation_design_checksum_mismatch',
    }));
    expect(fs.readdirSync(activationDesignDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    for (const input of [
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, liveHmSend: true },
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, activationDesign: { activationAllowed: true } },
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, activationDesign: { liveHmSendExecutionAllowed: true } },
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, audit: { sendPerformed: true } },
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, activationGate: { activationAllowed: true } },
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, activationRequest: { execute: true } },
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, adapterDryRun: { target: { telegramSend: true } } },
    ]) {
      const blockedActivationDesignResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-designs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedActivationDesignPayload = await blockedActivationDesignResponse.json();
      expect(blockedActivationDesignResponse.status).toBe(400);
      expect(blockedActivationDesignPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_internal_send_activation_design_has_live_effect',
      }));
      expect(fs.readdirSync(activationDesignDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    for (const input of [
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, command: 'hm-send oracle' },
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, activationDesign: { command: 'hm-send oracle' } },
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, activationRequest: { command: 'hm-send oracle' } },
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, rollbackPlan: { args: ['hm-send', 'oracle'] } },
      { internalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken, adapterDryRun: { body: { command: 'hm-send oracle' } } },
    ]) {
      const blockedCommandActivationDesignResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-designs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedCommandActivationDesignPayload = await blockedCommandActivationDesignResponse.json();
      expect(blockedCommandActivationDesignResponse.status).toBe(400);
      expect(blockedCommandActivationDesignPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_internal_send_activation_design_command_not_allowed',
      }));
      expect(fs.readdirSync(activationDesignDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    const activationRequestDir = path.join(tempStateRoot, 'mission-control', 'internal-send-activation-requests');
    const missingActivationRequestTokenResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const missingActivationRequestTokenPayload = await missingActivationRequestTokenResponse.json();
    const badActivationRequestTokenResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendActivationDesignToken: 'mission-send-activation-design-not-saved' }),
    });
    const badActivationRequestTokenPayload = await badActivationRequestTokenResponse.json();
    expect(missingActivationRequestTokenResponse.status).toBe(400);
    expect(missingActivationRequestTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_activation_design_token_required',
    }));
    expect(fs.existsSync(activationRequestDir)).toBe(false);
    expect(badActivationRequestTokenResponse.status).toBe(400);
    expect(badActivationRequestTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_activation_design_not_found',
    }));
    expect(fs.existsSync(activationRequestDir)).toBe(false);
    const activationRequestResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendActivationDesignToken: activationDesignPayload.design.actionToken }),
    });
    const activationRequestPayload = await activationRequestResponse.json();
    const duplicateActivationRequestResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activationDesignToken: activationDesignPayload.design.actionToken }),
    });
    const duplicateActivationRequestPayload = await duplicateActivationRequestResponse.json();
    const listActivationRequestResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-requests?includeInternal=1`);
    const listActivationRequestPayload = await listActivationRequestResponse.json();
    expect(activationRequestResponse.status).toBe(200);
    expect(activationRequestPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_request_preview_write.v0',
      created: true,
      relativePath: expect.stringMatching(/^mission-control\/internal-send-activation-requests\/mission-send-activation-request-.*\.json$/),
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
    }));
    expect(activationRequestPayload.request).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_send_activation_request_preview.v0',
      status: 'activation_request_review_only',
      sourceInternalSendActivationDesignId: activationDesignPayload.design.id,
      sourceInternalSendActivationDesignToken: activationDesignPayload.design.actionToken,
      sourceInternalSendDryRunToken: internalSendDryRunPayload.dryRun.actionToken,
      targetRole: 'oracle',
      targetPaneId: '3',
      targetLabel: 'oracle pane 3',
      content: 'Edited internal continuation for Oracle review.',
      bodySha256: internalSendDryRunPayload.dryRun.bodySha256,
      adapterPacketSha256: activationDesignPayload.design.adapterPacketSha256,
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
    }));
    expect(activationRequestPayload.request.reviewer).toEqual(expect.objectContaining({
      required: true,
      status: 'pending_review',
      reviewerRole: 'architect_or_oracle',
    }));
    expect(activationRequestPayload.request.activationRequest).toEqual({
      protocol: 'mira.mission_control_internal_send_activation_request_gate.v0',
      previewOnly: true,
      activationAllowed: false,
      requiredReview: 'separate_reviewed_activation',
      reviewerRequired: true,
      refusalRollbackAuditRequired: true,
      liveHmSendExecutionAllowed: false,
      realSendAllowed: false,
    });
    expect(activationRequestPayload.request.refusalPolicy.map((item) => item.id)).toEqual([
      'activation_design_token_required',
      'activation_design_checksum_required',
      'separate_activation_required',
    ]);
    expect(activationRequestPayload.request.rollbackPlan.map((item) => item.id)).toEqual([
      'rollback_path_required',
      'activation_design_checksum_required',
    ]);
    expect(activationRequestPayload.request.auditPlan.map((item) => item.id)).toEqual([
      'reviewer_required',
      'audit_path_required',
    ]);
    expect(activationRequestPayload.request.audit).toEqual(expect.objectContaining({
      reviewStatus: 'activation_request_preview_ready',
      previewOnly: true,
      manualExecutionRequired: true,
      realSendRequiresSeparateActivation: true,
      sourceActivationDesignChecksumMatched: true,
      reviewerRequired: true,
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
    }));
    expect(activationRequestPayload.request).not.toHaveProperty('command');
    expect(activationRequestPayload.request).not.toHaveProperty('args');
    expect(activationRequestPayload.request).not.toHaveProperty('delivery');
    const storedActivationRequest = JSON.parse(fs.readFileSync(activationRequestPayload.absolutePath, 'utf8'));
    expect(storedActivationRequest).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_send_activation_request_preview.v0',
      status: 'activation_request_review_only',
      sourceInternalSendActivationDesignToken: activationDesignPayload.design.actionToken,
      targetLabel: 'oracle pane 3',
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
    }));
    expect(storedActivationRequest).not.toHaveProperty('command');
    expect(storedActivationRequest).not.toHaveProperty('args');
    expect(storedActivationRequest).not.toHaveProperty('delivery');
    expect(duplicateActivationRequestResponse.status).toBe(200);
    expect(duplicateActivationRequestPayload.created).toBe(false);
    expect(duplicateActivationRequestPayload.relativePath).toBe(activationRequestPayload.relativePath);
    expect(listActivationRequestResponse.status).toBe(200);
    expect(listActivationRequestPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_request_preview_list.v0',
      stateRootPath: path.resolve(tempStateRoot),
      requestCount: 1,
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
    }));
    expect(listActivationRequestPayload.requests[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^mission-send-activation-request-/),
      relativePath: activationRequestPayload.relativePath,
      targetRole: 'oracle',
      targetPaneId: '3',
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));
    fs.writeFileSync(activationDesignPayload.absolutePath, `${JSON.stringify({
      ...storedActivationDesign,
      bodySha256: 'bad-body-sha256',
    }, null, 2)}\n`, 'utf8');
    const mismatchedActivationRequestResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendActivationDesignToken: activationDesignPayload.design.actionToken }),
    });
    const mismatchedActivationRequestPayload = await mismatchedActivationRequestResponse.json();
    fs.writeFileSync(activationDesignPayload.absolutePath, `${JSON.stringify(storedActivationDesign, null, 2)}\n`, 'utf8');
    expect(mismatchedActivationRequestResponse.status).toBe(400);
    expect(mismatchedActivationRequestPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_activation_request_checksum_mismatch',
    }));
    expect(fs.readdirSync(activationRequestDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    for (const input of [
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, liveHmSend: true },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, activationRequest: { activationAllowed: true } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, activationRequest: { liveHmSendExecutionAllowed: true } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, activationRequest: { body: { telegramSend: true } } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, request: { telegramSend: true } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, request: { target: { routeFlip: true } } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, reviewer: { externalSend: true } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, reviewer: { body: { liveHmSend: true } } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, auditPlan: { routeFlip: true } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, auditPlan: { target: { accountOrTokenAccess: true } } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, rollbackPlan: { bridgeDelivery: true } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, rollbackPlan: { body: { bridgeDelivery: true } } },
    ]) {
      const blockedActivationRequestResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedActivationRequestPayload = await blockedActivationRequestResponse.json();
      expect(blockedActivationRequestResponse.status).toBe(400);
      expect(blockedActivationRequestPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_internal_send_activation_request_has_live_effect',
      }));
      expect(fs.readdirSync(activationRequestDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    for (const input of [
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, command: 'hm-send oracle' },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, activationRequest: { command: 'hm-send oracle' } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, activationRequest: { body: { command: 'hm-send oracle' } } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, request: { args: ['hm-send', 'oracle'] } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, request: { target: { command: 'hm-send oracle' } } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, reviewer: { command: 'hm-send oracle' } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, reviewer: { body: { args: ['hm-send', 'oracle'] } } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, auditPlan: { args: ['hm-send', 'oracle'] } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, auditPlan: { target: { command: 'hm-send oracle' } } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, rollbackPlan: { command: 'hm-send oracle' } },
      { internalSendActivationDesignToken: activationDesignPayload.design.actionToken, rollbackPlan: { body: { args: ['hm-send', 'oracle'] } } },
    ]) {
      const blockedCommandActivationRequestResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedCommandActivationRequestPayload = await blockedCommandActivationRequestResponse.json();
      expect(blockedCommandActivationRequestResponse.status).toBe(400);
      expect(blockedCommandActivationRequestPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_internal_send_activation_request_command_not_allowed',
      }));
      expect(fs.readdirSync(activationRequestDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    const activationDecisionAuditDir = path.join(tempStateRoot, 'mission-control', 'internal-send-activation-decision-audits');
    const missingDecisionAuditTokenResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-decision-audits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const missingDecisionAuditTokenPayload = await missingDecisionAuditTokenResponse.json();
    const badDecisionAuditTokenResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-decision-audits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendActivationRequestToken: 'mission-send-activation-request-not-saved' }),
    });
    const badDecisionAuditTokenPayload = await badDecisionAuditTokenResponse.json();
    expect(missingDecisionAuditTokenResponse.status).toBe(400);
    expect(missingDecisionAuditTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_activation_request_token_required',
    }));
    expect(fs.existsSync(activationDecisionAuditDir)).toBe(false);
    expect(badDecisionAuditTokenResponse.status).toBe(400);
    expect(badDecisionAuditTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_activation_request_not_found',
    }));
    expect(fs.existsSync(activationDecisionAuditDir)).toBe(false);
    const decisionAuditResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-decision-audits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendActivationRequestToken: activationRequestPayload.request.actionToken }),
    });
    const decisionAuditPayload = await decisionAuditResponse.json();
    const duplicateDecisionAuditResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-decision-audits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activationRequestToken: activationRequestPayload.request.actionToken }),
    });
    const duplicateDecisionAuditPayload = await duplicateDecisionAuditResponse.json();
    const listDecisionAuditResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-decision-audits?includeInternal=1`);
    const listDecisionAuditPayload = await listDecisionAuditResponse.json();
    expect(decisionAuditResponse.status).toBe(200);
    expect(decisionAuditPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_decision_audit_write.v0',
      created: true,
      relativePath: expect.stringMatching(/^mission-control\/internal-send-activation-decision-audits\/mission-send-activation-audit-.*\.json$/),
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
    }));
    expect(decisionAuditPayload.audit).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_send_activation_decision_audit.v0',
      status: 'activation_decision_audit_review_only',
      sourceInternalSendActivationRequestId: activationRequestPayload.request.id,
      sourceInternalSendActivationRequestToken: activationRequestPayload.request.actionToken,
      sourceInternalSendActivationDesignToken: activationDesignPayload.design.actionToken,
      targetRole: 'oracle',
      targetPaneId: '3',
      targetLabel: 'oracle pane 3',
      content: 'Edited internal continuation for Oracle review.',
      bodySha256: activationRequestPayload.request.bodySha256,
      adapterPacketSha256: activationRequestPayload.request.adapterPacketSha256,
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
    }));
    expect(decisionAuditPayload.audit.decision).toEqual({
      protocol: 'mira.mission_control_internal_send_activation_decision.v0',
      reviewOnly: true,
      decision: 'refuse_live_activation_until_separate_gate',
      activationAllowed: false,
      liveHmSendExecutionAllowed: false,
      realSendAllowed: false,
      separateActivationRequired: true,
    });
    expect(decisionAuditPayload.audit.refusal).toEqual(expect.objectContaining({
      status: 'refused_for_live_execution',
      liveEffectBlocked: true,
    }));
    expect(decisionAuditPayload.audit.rollbackAudit).toEqual({
      status: 'rollback_audit_previewed',
      requiresPreActivationSnapshot: true,
      requiresFailureAudit: true,
      requiresTransportOutcomeAudit: true,
    });
    expect(decisionAuditPayload.audit.auditRequirements.map((item) => item.id)).toEqual([
      'activation_request_token_required',
      'activation_request_checksum_required',
      'review_decision_recorded',
      'refusal_recorded',
      'rollback_audit_recorded',
      'separate_activation_required',
    ]);
    expect(decisionAuditPayload.audit.audit).toEqual(expect.objectContaining({
      reviewStatus: 'activation_decision_audit_ready',
      reviewOnly: true,
      manualExecutionRequired: true,
      sourceActivationRequestChecksumMatched: true,
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
    }));
    expect(decisionAuditPayload.audit).not.toHaveProperty('command');
    expect(decisionAuditPayload.audit).not.toHaveProperty('args');
    expect(decisionAuditPayload.audit).not.toHaveProperty('delivery');
    const storedDecisionAudit = JSON.parse(fs.readFileSync(decisionAuditPayload.absolutePath, 'utf8'));
    expect(storedDecisionAudit).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_send_activation_decision_audit.v0',
      status: 'activation_decision_audit_review_only',
      sourceInternalSendActivationRequestToken: activationRequestPayload.request.actionToken,
      targetLabel: 'oracle pane 3',
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
    }));
    expect(storedDecisionAudit).not.toHaveProperty('command');
    expect(storedDecisionAudit).not.toHaveProperty('args');
    expect(storedDecisionAudit).not.toHaveProperty('delivery');
    expect(duplicateDecisionAuditResponse.status).toBe(200);
    expect(duplicateDecisionAuditPayload.created).toBe(false);
    expect(duplicateDecisionAuditPayload.relativePath).toBe(decisionAuditPayload.relativePath);
    expect(listDecisionAuditResponse.status).toBe(200);
    expect(listDecisionAuditPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_decision_audit_list.v0',
      stateRootPath: path.resolve(tempStateRoot),
      auditCount: 1,
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
    }));
    expect(listDecisionAuditPayload.audits[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^mission-send-activation-audit-/),
      relativePath: decisionAuditPayload.relativePath,
      targetRole: 'oracle',
      targetPaneId: '3',
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));
    fs.writeFileSync(activationRequestPayload.absolutePath, `${JSON.stringify({
      ...storedActivationRequest,
      bodySha256: 'bad-body-sha256',
    }, null, 2)}\n`, 'utf8');
    const mismatchedDecisionAuditResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-decision-audits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendActivationRequestToken: activationRequestPayload.request.actionToken }),
    });
    const mismatchedDecisionAuditPayload = await mismatchedDecisionAuditResponse.json();
    fs.writeFileSync(activationRequestPayload.absolutePath, `${JSON.stringify(storedActivationRequest, null, 2)}\n`, 'utf8');
    expect(mismatchedDecisionAuditResponse.status).toBe(400);
    expect(mismatchedDecisionAuditPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_activation_decision_audit_checksum_mismatch',
    }));
    expect(fs.readdirSync(activationDecisionAuditDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    for (const input of [
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, liveHmSend: true },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, decision: { activationAllowed: true } },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, decision: { body: { telegramSend: true } } },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, refusal: { externalSend: true } },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, rollbackAudit: { target: { routeFlip: true } } },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, audit: { body: { liveHmSend: true } } },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, request: { target: { accountOrTokenAccess: true } } },
    ]) {
      const blockedDecisionAuditResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-decision-audits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedDecisionAuditPayload = await blockedDecisionAuditResponse.json();
      expect(blockedDecisionAuditResponse.status).toBe(400);
      expect(blockedDecisionAuditPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_internal_send_activation_decision_audit_has_live_effect',
      }));
      expect(fs.readdirSync(activationDecisionAuditDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    for (const input of [
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, command: 'hm-send oracle' },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, decision: { command: 'hm-send oracle' } },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, decision: { body: { command: 'hm-send oracle' } } },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, refusal: { target: { args: ['hm-send', 'oracle'] } } },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, rollbackAudit: { body: { command: 'hm-send oracle' } } },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, audit: { args: ['hm-send', 'oracle'] } },
      { internalSendActivationRequestToken: activationRequestPayload.request.actionToken, request: { body: { command: 'hm-send oracle' } } },
    ]) {
      const blockedCommandDecisionAuditResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-decision-audits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedCommandDecisionAuditPayload = await blockedCommandDecisionAuditResponse.json();
      expect(blockedCommandDecisionAuditResponse.status).toBe(400);
      expect(blockedCommandDecisionAuditPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_internal_send_activation_decision_audit_command_not_allowed',
      }));
      expect(fs.readdirSync(activationDecisionAuditDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    const activationImplementationReadinessDir = path.join(tempStateRoot, 'mission-control', 'internal-send-activation-implementation-readiness');
    const missingImplementationReadinessTokenResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-implementation-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const missingImplementationReadinessTokenPayload = await missingImplementationReadinessTokenResponse.json();
    const badImplementationReadinessTokenResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-implementation-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendActivationDecisionAuditToken: 'mission-send-activation-audit-not-saved' }),
    });
    const badImplementationReadinessTokenPayload = await badImplementationReadinessTokenResponse.json();
    expect(missingImplementationReadinessTokenResponse.status).toBe(400);
    expect(missingImplementationReadinessTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_activation_decision_audit_token_required',
    }));
    expect(fs.existsSync(activationImplementationReadinessDir)).toBe(false);
    expect(badImplementationReadinessTokenResponse.status).toBe(400);
    expect(badImplementationReadinessTokenPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_activation_decision_audit_not_found',
    }));
    expect(fs.existsSync(activationImplementationReadinessDir)).toBe(false);
    const implementationReadinessResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-implementation-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken }),
    });
    const implementationReadinessPayload = await implementationReadinessResponse.json();
    const duplicateImplementationReadinessResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-implementation-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisionAuditToken: decisionAuditPayload.audit.actionToken }),
    });
    const duplicateImplementationReadinessPayload = await duplicateImplementationReadinessResponse.json();
    const listImplementationReadinessResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-implementation-readiness?includeInternal=1`);
    const listImplementationReadinessPayload = await listImplementationReadinessResponse.json();
    expect(implementationReadinessResponse.status).toBe(200);
    expect(implementationReadinessPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_implementation_readiness_write.v0',
      created: true,
      relativePath: expect.stringMatching(/^mission-control\/internal-send-activation-implementation-readiness\/mission-send-activation-implementation-.*\.json$/),
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
    }));
    expect(implementationReadinessPayload.readiness).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_send_activation_implementation_readiness.v0',
      status: 'activation_implementation_readiness_review_only',
      sourceInternalSendActivationDecisionAuditId: decisionAuditPayload.audit.id,
      sourceInternalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken,
      sourceInternalSendActivationRequestToken: activationRequestPayload.request.actionToken,
      targetRole: 'oracle',
      targetPaneId: '3',
      targetLabel: 'oracle pane 3',
      content: 'Edited internal continuation for Oracle review.',
      bodySha256: decisionAuditPayload.audit.bodySha256,
      adapterPacketSha256: decisionAuditPayload.audit.adapterPacketSha256,
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
    }));
    expect(implementationReadinessPayload.readiness.implementationGate).toEqual({
      protocol: 'mira.mission_control_internal_send_activation_implementation_gate.v0',
      readinessOnly: true,
      disabledByDefault: true,
      implementationEnabled: false,
      activationAllowed: false,
      liveHmSendExecutionAllowed: false,
      realSendAllowed: false,
      separateActivationRequired: true,
    });
    expect(implementationReadinessPayload.readiness.refusal).toEqual(expect.objectContaining({
      status: 'live_activation_still_refused',
      sourceDecision: 'refuse_live_activation_until_separate_gate',
    }));
    expect(implementationReadinessPayload.readiness.rollback).toEqual({
      status: 'rollback_requirements_ready',
      preActivationSnapshotRequired: true,
      failureAuditRequired: true,
      transportOutcomeAuditRequired: true,
    });
    expect(implementationReadinessPayload.readiness.auditRequirements.map((item) => item.id)).toEqual([
      'decision_audit_token_required',
      'decision_audit_checksum_required',
      'decision_refusal_required',
      'disabled_by_default_required',
      'rollback_audit_required',
      'separate_activation_required',
    ]);
    expect(implementationReadinessPayload.readiness.audit).toEqual(expect.objectContaining({
      reviewStatus: 'activation_implementation_readiness_ready',
      readinessOnly: true,
      disabledByDefault: true,
      implementationEnabled: false,
      manualExecutionRequired: true,
      sourceDecisionAuditChecksumMatched: true,
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
    }));
    expect(implementationReadinessPayload.readiness).not.toHaveProperty('command');
    expect(implementationReadinessPayload.readiness).not.toHaveProperty('args');
    expect(implementationReadinessPayload.readiness).not.toHaveProperty('delivery');
    const storedImplementationReadiness = JSON.parse(fs.readFileSync(implementationReadinessPayload.absolutePath, 'utf8'));
    expect(storedImplementationReadiness).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_send_activation_implementation_readiness.v0',
      status: 'activation_implementation_readiness_review_only',
      sourceInternalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken,
      targetLabel: 'oracle pane 3',
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
    }));
    expect(storedImplementationReadiness).not.toHaveProperty('command');
    expect(storedImplementationReadiness).not.toHaveProperty('args');
    expect(storedImplementationReadiness).not.toHaveProperty('delivery');
    expect(duplicateImplementationReadinessResponse.status).toBe(200);
    expect(duplicateImplementationReadinessPayload.created).toBe(false);
    expect(duplicateImplementationReadinessPayload.relativePath).toBe(implementationReadinessPayload.relativePath);
    expect(listImplementationReadinessResponse.status).toBe(200);
    expect(listImplementationReadinessPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_send_activation_implementation_readiness_list.v0',
      stateRootPath: path.resolve(tempStateRoot),
      readinessCount: 1,
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
    }));
    expect(listImplementationReadinessPayload.readiness[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^mission-send-activation-ready-/),
      relativePath: implementationReadinessPayload.relativePath,
      targetRole: 'oracle',
      targetPaneId: '3',
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));
    fs.writeFileSync(decisionAuditPayload.absolutePath, `${JSON.stringify({
      ...storedDecisionAudit,
      bodySha256: 'bad-body-sha256',
    }, null, 2)}\n`, 'utf8');
    const mismatchedImplementationReadinessResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-implementation-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken }),
    });
    const mismatchedImplementationReadinessPayload = await mismatchedImplementationReadinessResponse.json();
    fs.writeFileSync(decisionAuditPayload.absolutePath, `${JSON.stringify(storedDecisionAudit, null, 2)}\n`, 'utf8');
    expect(mismatchedImplementationReadinessResponse.status).toBe(400);
    expect(mismatchedImplementationReadinessPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_internal_send_activation_implementation_readiness_checksum_mismatch',
    }));
    expect(fs.readdirSync(activationImplementationReadinessDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    for (const input of [
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, liveHmSend: true },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, implementationReadiness: { implementationEnabled: true } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, implementation: { target: { telegramSend: true } } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, activationImplementation: { body: { liveHmSendExecutionAllowed: true } } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, gate: { activationAllowed: true } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, refusal: { externalSend: true } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, rollbackAudit: { body: { routeFlip: true } } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, audit: { target: { providerInvoked: true } } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, decisionAudit: { body: { accountOrTokenAccess: true } } },
    ]) {
      const blockedImplementationReadinessResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-implementation-readiness`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedImplementationReadinessPayload = await blockedImplementationReadinessResponse.json();
      expect(blockedImplementationReadinessResponse.status).toBe(400);
      expect(blockedImplementationReadinessPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_internal_send_activation_implementation_readiness_has_live_effect',
      }));
      expect(fs.readdirSync(activationImplementationReadinessDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    for (const input of [
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, command: 'hm-send oracle' },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, implementationReadiness: { command: 'hm-send oracle' } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, implementation: { body: { command: 'hm-send oracle' } } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, activationImplementation: { target: { args: ['hm-send', 'oracle'] } } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, gate: { args: ['hm-send', 'oracle'] } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, rollbackAudit: { target: { command: 'hm-send oracle' } } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, audit: { args: ['hm-send', 'oracle'] } },
      { internalSendActivationDecisionAuditToken: decisionAuditPayload.audit.actionToken, decisionAudit: { body: { command: 'hm-send oracle' } } },
    ]) {
      const blockedCommandImplementationReadinessResponse = await fetch(`${baseUrl}/mission-control/internal-send-activation-implementation-readiness`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedCommandImplementationReadinessPayload = await blockedCommandImplementationReadinessResponse.json();
      expect(blockedCommandImplementationReadinessResponse.status).toBe(400);
      expect(blockedCommandImplementationReadinessPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_internal_send_activation_implementation_readiness_command_not_allowed',
      }));
      expect(fs.readdirSync(activationImplementationReadinessDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    fs.writeFileSync(deliveryPreviewPayload.absolutePath, `${JSON.stringify({
      ...storedDeliveryPreview,
      reviewDetails: {
        ...storedDeliveryPreview.reviewDetails,
        bodySha256: 'bad-body-sha256',
      },
    }, null, 2)}\n`, 'utf8');
    const mismatchedDispatchReadinessResponse = await fetch(`${baseUrl}/mission-control/dispatch-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken }),
    });
    const mismatchedDispatchReadinessPayload = await mismatchedDispatchReadinessResponse.json();
    fs.writeFileSync(deliveryPreviewPayload.absolutePath, `${JSON.stringify(storedDeliveryPreview, null, 2)}\n`, 'utf8');
    expect(mismatchedDispatchReadinessResponse.status).toBe(400);
    expect(mismatchedDispatchReadinessPayload.error).toEqual(expect.objectContaining({
      code: 'mission_control_dispatch_readiness_checksum_mismatch',
    }));
    expect(fs.readdirSync(dispatchReadinessDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    for (const input of [
      { deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken, telegramSend: true },
      { deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken, audit: { liveHmSend: true } },
      { deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken, deliveryPacket: { body: { routeFlip: true } } },
      { deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken, copiedPaneMessage: { externalSend: true } },
      { deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken, copiedPaneMessage: { body: { telegramSend: true } } },
    ]) {
      const blockedDispatchReadinessResponse = await fetch(`${baseUrl}/mission-control/dispatch-readiness`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedDispatchReadinessPayload = await blockedDispatchReadinessResponse.json();
      expect(blockedDispatchReadinessResponse.status).toBe(400);
      expect(blockedDispatchReadinessPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_dispatch_readiness_has_live_effect',
      }));
      expect(fs.readdirSync(dispatchReadinessDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    for (const input of [
      { deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken, command: 'hm-send oracle' },
      { deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken, packet: { args: ['hm-send', 'oracle'] } },
      { deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken, deliveryPacket: { body: { command: 'hm-send oracle' } } },
      { deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken, copiedPaneMessage: { command: 'hm-send oracle' } },
      { deliveryPreviewToken: deliveryPreviewPayload.preview.actionToken, copiedPaneMessage: { body: { command: 'hm-send oracle' } } },
    ]) {
      const blockedCommandDispatchReadinessResponse = await fetch(`${baseUrl}/mission-control/dispatch-readiness`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedCommandDispatchReadinessPayload = await blockedCommandDispatchReadinessResponse.json();
      expect(blockedCommandDispatchReadinessResponse.status).toBe(400);
      expect(blockedCommandDispatchReadinessPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_dispatch_readiness_command_not_allowed',
      }));
      expect(fs.readdirSync(dispatchReadinessDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    for (const input of [
      { recommendationToken: followThroughPayload.selectedRecommendation.actionToken, telegramSend: true },
      { recommendationToken: followThroughPayload.selectedRecommendation.actionToken, audit: { providerInvoked: true } },
      { recommendationToken: followThroughPayload.selectedRecommendation.actionToken, deliveryPacket: { body: { liveHmSend: true } } },
    ]) {
      const blockedDeliveryPreviewResponse = await fetch(`${baseUrl}/mission-control/internal-delivery-previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedDeliveryPreviewPayload = await blockedDeliveryPreviewResponse.json();
      expect(blockedDeliveryPreviewResponse.status).toBe(400);
      expect(blockedDeliveryPreviewPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_delivery_preview_has_live_effect',
      }));
      expect(fs.readdirSync(deliveryPreviewDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    for (const input of [
      { recommendationToken: followThroughPayload.selectedRecommendation.actionToken, command: { executable: process.execPath } },
      { recommendationToken: followThroughPayload.selectedRecommendation.actionToken, packet: { args: ['hm-send', 'oracle'] } },
      { recommendationToken: followThroughPayload.selectedRecommendation.actionToken, deliveryPacket: { body: { command: 'hm-send oracle' } } },
    ]) {
      const blockedCommandDeliveryPreviewResponse = await fetch(`${baseUrl}/mission-control/internal-delivery-previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedCommandDeliveryPreviewPayload = await blockedCommandDeliveryPreviewResponse.json();
      expect(blockedCommandDeliveryPreviewResponse.status).toBe(400);
      expect(blockedCommandDeliveryPreviewPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_delivery_preview_command_not_allowed',
      }));
      expect(fs.readdirSync(deliveryPreviewDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
    for (const input of [
      { requestToken: createRequestPayload.request.actionToken, decision: 'approve', telegramSend: true },
      { requestToken: createRequestPayload.request.actionToken, decision: 'approve', audit: { accountOrTokenAccess: true } },
      { requestToken: createRequestPayload.request.actionToken, decision: 'approve', plan: { liveHmSend: true } },
    ]) {
      const blockedContinuationResponse = await fetch(`${baseUrl}/mission-control/owned-work-continuations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedContinuationPayload = await blockedContinuationResponse.json();
      expect(blockedContinuationResponse.status).toBe(400);
      expect(blockedContinuationPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_continuation_has_live_effect',
      }));
      expect(fs.readdirSync(continuationDir).filter((file) => file.endsWith('.json'))).toHaveLength(3);
    }
    for (const input of [
      { requestToken: createRequestPayload.request.actionToken, decision: 'approve', command: { executable: process.execPath } },
      { requestToken: createRequestPayload.request.actionToken, decision: 'approve', args: ['hm-send', 'oracle'] },
      { requestToken: createRequestPayload.request.actionToken, decision: 'approve', plan: { command: { executable: process.execPath } } },
      { requestToken: createRequestPayload.request.actionToken, decision: 'approve', audit: { args: ['hm-send', 'oracle'] } },
    ]) {
      const blockedCommandContinuationResponse = await fetch(`${baseUrl}/mission-control/owned-work-continuations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const blockedCommandContinuationPayload = await blockedCommandContinuationResponse.json();
      expect(blockedCommandContinuationResponse.status).toBe(400);
      expect(blockedCommandContinuationPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_continuation_command_not_allowed',
      }));
      expect(fs.readdirSync(continuationDir).filter((file) => file.endsWith('.json'))).toHaveLength(3);
    }

    const previewDir = path.join(tempStateRoot, 'mission-control', 'route-previews');
    for (const flag of ['telegramSend', 'accountOrTokenAccess', 'liveHmSend']) {
      const badRecord = {
        ...savePayload.record,
        id: `mission-route-preview-bad-${flag}`,
        content: `This corrupted saved preview has ${flag} true.`,
        contentPreview: `This corrupted saved preview has ${flag} true.`,
        [flag]: true,
      };
      delete badRecord.actionToken;
      fs.writeFileSync(path.join(previewDir, `${badRecord.id}.json`), `${JSON.stringify(badRecord, null, 2)}\n`, 'utf8');
      const blockedResponse = await fetch(`${baseUrl}/mission-control/internal-route-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          previewToken: routeRequestToken(badRecord.id),
        }),
      });
      const blockedPayload = await blockedResponse.json();
      expect(blockedResponse.status).toBe(400);
      expect(blockedPayload.error).toEqual(expect.objectContaining({
        code: 'mission_control_route_preview_not_found',
      }));
      expect(fs.readdirSync(routeRequestDir).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    }
  });

  test('creates and lists pending-review customer work drafts without external send', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-work-draft-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const createResponse = await fetch(`${baseUrl}/work/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'customer_reply',
        text: 'Reply to the customer asking whether the invoice can be re-sent today.',
        sessionId: 'app-session-373',
        messageId: 'work-draft-test-1',
      }),
    });
    const createPayload = await createResponse.json();
    const listResponse = await fetch(`${baseUrl}/work/drafts`);
    const listPayload = await listResponse.json();

    expect(createResponse.status).toBe(200);
    expect(createPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_draft.v0',
      kind: 'customer_reply',
      status: 'pending_review',
      stateRootPath: path.resolve(tempStateRoot),
      externalSend: false,
      runtimeExecutesExternalAction: false,
      reviewRequired: true,
    }));
    expect(createPayload.relativePath).toMatch(/^work\/drafts\/work-draft-.*\.md$/);
    expect(createPayload.absolutePath.startsWith(path.resolve(tempStateRoot))).toBe(true);
    expect(createPayload.preview).toContain('Request: Reply to the customer asking whether the invoice can be re-sent today.');
    expect(createPayload.preview).toContain('Draft: Thanks for reaching out.');
    expect(createPayload.displayTitle).toBe('Customer reply');
    expect(createPayload.requestPreview).toBe('Reply to the customer asking whether the invoice can be re-sent today.');
    expect(createPayload.draftPreview).toContain('Thanks for reaching out.');
    expect(createPayload.preview).not.toContain('schema: mira.work_draft.v0');
    expect(createPayload.preview).not.toContain('session_id');
    expect(createPayload.preview).not.toContain('external_send');
    expect(createPayload.preview).not.toContain('---');
    expect(fs.existsSync(createPayload.absolutePath)).toBe(true);
    const writtenDraft = fs.readFileSync(createPayload.absolutePath, 'utf8');
    expect(writtenDraft).toContain('schema: mira.work_draft.v0');
    expect(writtenDraft).toContain('status: pending_review');
    expect(writtenDraft).toContain('external_send: false');
    expect(writtenDraft).toContain('runtime_executes_external_action: false');
    expect(writtenDraft).toContain('Reply to the customer asking whether the invoice can be re-sent today.');

    expect(listResponse.status).toBe(200);
    expect(listPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_draft_list.v0',
      stateRootPath: null,
      draftCount: 1,
      externalSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(listPayload.drafts[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^draft-/),
      status: 'pending_review',
      displayTitle: 'Customer reply',
      requestPreview: 'Reply to the customer asking whether the invoice can be re-sent today.',
      preview: expect.stringContaining('Request: Reply to the customer asking whether the invoice can be re-sent today.'),
    }));
    expect(listPayload.drafts[0]).not.toHaveProperty('id');
    expect(listPayload.drafts[0]).not.toHaveProperty('relativePath');
    expect(listPayload.drafts[0]).not.toHaveProperty('absolutePath');
    expect(listPayload.drafts[0].preview).not.toContain('schema: mira.work_draft.v0');
    expect(listPayload.drafts[0].preview).not.toContain('session_id');
    expect(listPayload.drafts[0].preview).not.toContain('external_send');
    expect(listPayload.drafts[0].preview).not.toContain('Customer Reply Draft');
  });

  test('converts a customer draft into a pending-review task with source hash', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-work-task-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const createDraftResponse = await fetch(`${baseUrl}/work/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'customer_reply',
        text: 'Reply to the customer asking whether the invoice can be re-sent today.',
        sessionId: 'app-session-373',
        messageId: 'work-task-source-draft-1',
      }),
    });
    const draft = await createDraftResponse.json();
    const draftMarkdown = fs.readFileSync(draft.absolutePath, 'utf8');
    const draftSha256 = crypto.createHash('sha256').update(draftMarkdown, 'utf8').digest('hex');
    const draftListResponse = await fetch(`${baseUrl}/work/drafts`);
    const draftList = await draftListResponse.json();

    const createTaskResponse = await fetch(`${baseUrl}/work/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceDraftToken: draftList.drafts[0].actionToken,
        sessionId: 'app-session-373',
        messageId: 'work-task-test-1',
      }),
    });
    const task = await createTaskResponse.json();
    const listResponse = await fetch(`${baseUrl}/work/tasks`);
    const listPayload = await listResponse.json();

    expect(createTaskResponse.status).toBe(200);
    expect(task).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_task.v0',
      kind: 'draft_intake_task',
      status: 'pending_review',
      sourceDraftId: draft.id,
      sourceDraftRelativePath: draft.relativePath,
      sourceDraftSha256: draftSha256,
      externalSend: false,
      crmMutation: false,
      runtimeExecutesExternalAction: false,
      reviewRequired: true,
    }));
    expect(task.relativePath).toMatch(/^work\/tasks\/work-task-.*\.md$/);
    expect(task.absolutePath.startsWith(path.resolve(tempStateRoot))).toBe(true);
    expect(task.preview).toContain('Task: Reply to the customer asking whether the invoice can be re-sent today.');
    expect(task.preview).toContain('Checklist:');
    expect(task.displayTitle).toBe('Review task');
    expect(task.taskPreview).toBe('Reply to the customer asking whether the invoice can be re-sent today.');
    expect(task.checklistPreview).toContain('Read the linked draft.');
    expect(task.preview).not.toContain('schema: mira.work_task.v0');
    expect(task.preview).not.toContain('source_draft_id');
    expect(task.preview).not.toContain('source_draft_relative_path');
    expect(task.preview).not.toContain('source_draft_sha256');
    const taskMarkdown = fs.readFileSync(task.absolutePath, 'utf8');
    expect(taskMarkdown).toContain('schema: mira.work_task.v0');
    expect(taskMarkdown).toContain('status: pending_review');
    expect(taskMarkdown).toContain(`source_draft_id: ${draft.id}`);
    expect(taskMarkdown).toContain(`source_draft_relative_path: ${draft.relativePath}`);
    expect(taskMarkdown).toContain(`source_draft_sha256: ${draftSha256}`);
    expect(taskMarkdown).toContain('external_send: false');
    expect(taskMarkdown).toContain('crm_mutation: false');
    expect(taskMarkdown).toContain('runtime_executes_external_action: false');
    expect(taskMarkdown).toContain('Do not send externally or mutate CRM from this task.');

    expect(listResponse.status).toBe(200);
    expect(listPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_task_list.v0',
      stateRootPath: null,
      taskCount: 1,
      pendingCount: 1,
      reviewedCount: 0,
      externalSend: false,
      crmMutation: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(listPayload.tasks[0]).toEqual(expect.objectContaining({
      actionToken: expect.stringMatching(/^task-/),
      status: 'pending_review',
      displayTitle: 'Review task',
      sourceDraftLinked: true,
      taskPreview: 'Reply to the customer asking whether the invoice can be re-sent today.',
      preview: expect.stringContaining('Task: Reply to the customer asking whether the invoice can be re-sent today.'),
    }));
    expect(listPayload.tasks[0]).not.toHaveProperty('id');
    expect(listPayload.tasks[0]).not.toHaveProperty('relativePath');
    expect(listPayload.tasks[0]).not.toHaveProperty('sourceDraftId');
    expect(listPayload.tasks[0]).not.toHaveProperty('sourceDraftRelativePath');
    expect(listPayload.tasks[0]).not.toHaveProperty('sourceDraftSha256');
    expect(listPayload.tasks[0].preview).not.toContain('schema: mira.work_task.v0');
    expect(listPayload.tasks[0].preview).not.toContain('source_draft_id');
    expect(listPayload.tasks[0].preview).not.toContain('source_draft_relative_path');
    expect(listPayload.tasks[0].preview).not.toContain('source_draft_sha256');

    const detailResponse = await fetch(`${baseUrl}/work/task-review?taskToken=${encodeURIComponent(listPayload.tasks[0].actionToken)}`);
    const detailPayload = await detailResponse.json();
    expect(detailResponse.status).toBe(200);
    expect(detailPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_task_review_detail.v0',
      externalSend: false,
      crmMutation: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(detailPayload.task).toEqual(expect.objectContaining({
      actionToken: listPayload.tasks[0].actionToken,
      status: 'pending_review',
      taskPreview: 'Reply to the customer asking whether the invoice can be re-sent today.',
    }));
    expect(detailPayload.linkedDraft).toEqual(expect.objectContaining({
      displayTitle: 'Linked draft',
      requestPreview: 'Reply to the customer asking whether the invoice can be re-sent today.',
      editableDraft: expect.stringContaining('Thanks for reaching out.'),
    }));
    expect(JSON.stringify(detailPayload)).not.toContain('source_draft_sha256');

    const reviewResponse = await fetch(`${baseUrl}/work/task-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskToken: listPayload.tasks[0].actionToken,
        decision: 'edit',
        editedDraftText: 'Yes, I can resend the invoice on May 15, 2026 after I verify the attachment and amount.',
        note: 'cleaned before manual send',
      }),
    });
    const reviewPayload = await reviewResponse.json();
    expect(reviewResponse.status).toBe(200);
    expect(reviewPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_task_review_write.v0',
      externalSend: false,
      crmMutation: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(reviewPayload.review).toEqual(expect.objectContaining({
      protocol: 'mira.work_task_review.v0',
      taskToken: listPayload.tasks[0].actionToken,
      reviewToken: expect.stringMatching(/^review-/),
      decision: 'edit',
      status: 'edited',
      editedDraftText: 'Yes, I can resend the invoice on May 15, 2026 after I verify the attachment and amount.',
    }));
    expect(fs.existsSync(reviewPayload.absolutePath)).toBe(true);

    const createReadyResponse = await fetch(`${baseUrl}/work/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskToken: listPayload.tasks[0].actionToken,
        reviewToken: reviewPayload.review.reviewToken,
      }),
    });
    const readyPayload = await createReadyResponse.json();
    expect(createReadyResponse.status).toBe(200);
    expect(readyPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_ready_package.v0',
      externalSend: false,
      crmMutation: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(readyPayload.ready).toEqual(expect.objectContaining({
      token: expect.stringMatching(/^ready-/),
      status: 'ready_to_send',
      taskToken: listPayload.tasks[0].actionToken,
      reviewToken: reviewPayload.review.reviewToken,
      reviewDecision: 'edit',
      finalReplyText: 'Yes, I can resend the invoice on May 15, 2026 after I verify the attachment and amount.',
      externalSend: false,
      crmMutation: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(JSON.stringify(readyPayload.ready)).not.toMatch(/absolutePath|relativePath|sourceDraft|sha256|schema:|---|frontmatter|id"/);

    const duplicateReadyResponse = await fetch(`${baseUrl}/work/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskToken: listPayload.tasks[0].actionToken,
        reviewToken: reviewPayload.review.reviewToken,
      }),
    });
    const duplicateReadyPayload = await duplicateReadyResponse.json();
    expect(duplicateReadyResponse.status).toBe(200);
    expect(duplicateReadyPayload.ready).toEqual(readyPayload.ready);

    const readyListResponse = await fetch(`${baseUrl}/work/ready`);
    const readyListPayload = await readyListResponse.json();
    expect(readyListResponse.status).toBe(200);
    expect(readyListPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_ready_package_list.v0',
      readyCount: 1,
      externalSend: false,
      crmMutation: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(readyListPayload.ready[0]).toEqual(expect.objectContaining({
      token: readyPayload.ready.token,
      finalReplyText: readyPayload.ready.finalReplyText,
      status: 'ready_to_send',
    }));
    expect(JSON.stringify(readyListPayload)).not.toMatch(/absolutePath|relativePath|sourceDraft|sha256|schema:|---|frontmatter|id"/);

    const readyGetResponse = await fetch(`${baseUrl}/work/ready?readyToken=${encodeURIComponent(readyPayload.ready.token)}`);
    const readyGetPayload = await readyGetResponse.json();
    expect(readyGetResponse.status).toBe(200);
    expect(readyGetPayload.ready).toEqual(readyPayload.ready);

    const createPacketResponse = await fetch(`${baseUrl}/work/send-packets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        readyToken: readyPayload.ready.token,
        recipient: 'ap@example.test',
        channel: 'email',
      }),
    });
    const packetPayload = await createPacketResponse.json();
    expect(createPacketResponse.status).toBe(200);
    expect(packetPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_send_packet.v0',
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(packetPayload.packet).toEqual(expect.objectContaining({
      token: expect.stringMatching(/^send-/),
      status: 'needs_final_send_confirmation',
      readyToken: readyPayload.ready.token,
      recipient: 'ap@example.test',
      channel: 'email',
      finalReplyText: readyPayload.ready.finalReplyText,
      notSent: true,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(JSON.stringify(packetPayload.packet)).not.toMatch(/absolutePath|relativePath|sourceDraft|sha256|schema:|---|frontmatter|id"|sentAt|delivery/);

    const duplicatePacketResponse = await fetch(`${baseUrl}/work/send-packets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        readyToken: readyPayload.ready.token,
        recipient: 'different@example.test',
        channel: 'sms',
      }),
    });
    const duplicatePacketPayload = await duplicatePacketResponse.json();
    expect(duplicatePacketResponse.status).toBe(200);
    expect(duplicatePacketPayload.packet).toEqual(packetPayload.packet);

    const packetListResponse = await fetch(`${baseUrl}/work/send-packets`);
    const packetListPayload = await packetListResponse.json();
    expect(packetListResponse.status).toBe(200);
    expect(packetListPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_send_packet_list.v0',
      packetCount: 1,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(packetListPayload.packets[0]).toEqual(packetPayload.packet);
    expect(JSON.stringify(packetListPayload)).not.toMatch(/absolutePath|relativePath|sourceDraft|sha256|schema:|---|frontmatter|id"|sentAt|delivery/);

    const packetGetResponse = await fetch(`${baseUrl}/work/send-packets?packetToken=${encodeURIComponent(packetPayload.packet.token)}`);
    const packetGetPayload = await packetGetResponse.json();
    expect(packetGetResponse.status).toBe(200);
    expect(packetGetPayload.packet).toEqual(packetPayload.packet);

    const missingConfirmationTextResponse = await fetch(`${baseUrl}/work/send-confirmations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packetToken: packetPayload.packet.token,
        confirmText: '',
      }),
    });
    const missingConfirmationTextPayload = await missingConfirmationTextResponse.json();
    expect(missingConfirmationTextResponse.status).toBe(400);
    expect(missingConfirmationTextPayload.error).toEqual(expect.objectContaining({
      code: 'missing_send_packet_field',
    }));

    const createConfirmationResponse = await fetch(`${baseUrl}/work/send-confirmations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packetToken: packetPayload.packet.token,
        confirmText: 'James confirmed this for manual send review.',
        confirmedBy: 'James',
        status: 'ready_for_external_adapter',
      }),
    });
    const confirmationPayload = await createConfirmationResponse.json();
    expect(createConfirmationResponse.status).toBe(200);
    expect(confirmationPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_send_confirmation.v0',
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(confirmationPayload.confirmation).toEqual(expect.objectContaining({
      token: expect.stringMatching(/^confirm-/),
      status: 'confirmed_for_manual_send',
      packetToken: packetPayload.packet.token,
      confirmedBy: 'James',
      confirmText: 'James confirmed this for manual send review.',
      recipient: 'ap@example.test',
      channel: 'email',
      finalReplyText: readyPayload.ready.finalReplyText,
      displayTitle: 'Manual confirmation',
      notSent: true,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(JSON.stringify(confirmationPayload.confirmation)).not.toMatch(/absolutePath|relativePath|sourceDraft|sha256|schema:|---|frontmatter|id"|sentAt|delivery|ready_for_external_adapter/);

    const duplicateConfirmationResponse = await fetch(`${baseUrl}/work/send-confirmations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packetToken: packetPayload.packet.token,
        confirmText: 'Different note should not create a duplicate.',
        confirmedBy: 'Someone Else',
      }),
    });
    const duplicateConfirmationPayload = await duplicateConfirmationResponse.json();
    expect(duplicateConfirmationResponse.status).toBe(200);
    expect(duplicateConfirmationPayload.confirmation).toEqual(confirmationPayload.confirmation);

    const confirmationListResponse = await fetch(`${baseUrl}/work/send-confirmations`);
    const confirmationListPayload = await confirmationListResponse.json();
    expect(confirmationListResponse.status).toBe(200);
    expect(confirmationListPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_send_confirmation_list.v0',
      confirmationCount: 1,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(confirmationListPayload.confirmations[0]).toEqual(confirmationPayload.confirmation);
    expect(JSON.stringify(confirmationListPayload)).not.toMatch(/absolutePath|relativePath|sourceDraft|sha256|schema:|---|frontmatter|id"|sentAt|delivery|ready_for_external_adapter/);

    const confirmationGetResponse = await fetch(`${baseUrl}/work/send-confirmations?confirmationToken=${encodeURIComponent(confirmationPayload.confirmation.token)}`);
    const confirmationGetPayload = await confirmationGetResponse.json();
    expect(confirmationGetResponse.status).toBe(200);
    expect(confirmationGetPayload.confirmation).toEqual(confirmationPayload.confirmation);

    const createCheckResponse = await fetch(`${baseUrl}/work/send-checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmationToken: confirmationPayload.confirmation.token,
      }),
    });
    const checkPayload = await createCheckResponse.json();
    expect(createCheckResponse.status).toBe(200);
    expect(checkPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_send_check.v0',
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(checkPayload.check).toEqual(expect.objectContaining({
      token: expect.stringMatching(/^check-/),
      status: 'ready_for_manual_send',
      confirmationToken: confirmationPayload.confirmation.token,
      packetToken: packetPayload.packet.token,
      recipient: 'ap@example.test',
      channel: 'email',
      finalReplyText: readyPayload.ready.finalReplyText,
      originalRequest: 'Reply to the customer asking whether the invoice can be re-sent today.',
      displayTitle: 'Looks ready to send manually',
      notSent: true,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(checkPayload.check.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'recipient and channel are filled in', ok: true }),
      expect.objectContaining({ label: 'reply appears to answer the original request', ok: true }),
      expect.objectContaining({ label: 'reply text is present', ok: true }),
      expect.objectContaining({ label: 'no missing facts called out', ok: true }),
      expect.objectContaining({ label: 'no vague promise without a concrete next step', ok: true }),
      expect.objectContaining({ label: 'no ambiguous date or time wording', ok: true }),
      expect.objectContaining({ label: 'does not claim anything was already sent', ok: true }),
      expect.objectContaining({ label: 'no risky customer wording', ok: true }),
    ]));
    expect(checkPayload.check.notes.join(' ')).toContain('Looks ready to send manually');
    expect(checkPayload.check.notes.join(' ')).toContain('Still not sent');
    expect(JSON.stringify(checkPayload.check)).not.toMatch(/absolutePath|relativePath|sourceDraft|sha256|schema:|---|frontmatter|id"|sentAt|delivery|external_adapter/);

    const duplicateCheckResponse = await fetch(`${baseUrl}/work/send-checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmationToken: confirmationPayload.confirmation.token,
      }),
    });
    const duplicateCheckPayload = await duplicateCheckResponse.json();
    expect(duplicateCheckResponse.status).toBe(200);
    expect(duplicateCheckPayload.check).toEqual(checkPayload.check);

    const checkListResponse = await fetch(`${baseUrl}/work/send-checks`);
    const checkListPayload = await checkListResponse.json();
    expect(checkListResponse.status).toBe(200);
    expect(checkListPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_send_check_list.v0',
      checkCount: 1,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(checkListPayload.checks[0]).toEqual(checkPayload.check);
    expect(JSON.stringify(checkListPayload)).not.toMatch(/absolutePath|relativePath|sourceDraft|sha256|schema:|---|frontmatter|id"|sentAt|delivery|external_adapter/);

    const checkGetResponse = await fetch(`${baseUrl}/work/send-checks?checkToken=${encodeURIComponent(checkPayload.check.token)}`);
    const checkGetPayload = await checkGetResponse.json();
    expect(checkGetResponse.status).toBe(200);
    expect(checkGetPayload.check).toEqual(checkPayload.check);

    const reviewedListResponse = await fetch(`${baseUrl}/work/tasks`);
    const reviewedListPayload = await reviewedListResponse.json();
    expect(reviewedListPayload).toEqual(expect.objectContaining({
      taskCount: 1,
      pendingCount: 0,
      reviewedCount: 1,
    }));
    expect(reviewedListPayload.tasks[0]).toEqual(expect.objectContaining({
      actionToken: listPayload.tasks[0].actionToken,
      status: 'edited',
      reviewedAt: expect.any(String),
    }));

    const reviewedDetailResponse = await fetch(`${baseUrl}/work/task-review?taskToken=${encodeURIComponent(listPayload.tasks[0].actionToken)}`);
    const reviewedDetailPayload = await reviewedDetailResponse.json();
    expect(reviewedDetailResponse.status).toBe(200);
    expect(reviewedDetailPayload.ready.ready).toEqual(readyPayload.ready);
    expect(JSON.stringify(reviewedDetailPayload.ready)).not.toMatch(/absolutePath|relativePath|sourceDraft|sha256|schema:|---|frontmatter|id"/);
  });

  test('refuses ready packages for pending or rejected reviews', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-work-ready-refuse-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const createDraftResponse = await fetch(`${baseUrl}/work/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'customer_reply',
        text: 'Reply to the customer saying the appointment time needs confirmation.',
      }),
    });
    const draft = await createDraftResponse.json();
    const createTaskResponse = await fetch(`${baseUrl}/work/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceDraftToken: draft.actionToken || undefined, sourceDraftId: draft.id }),
    });
    const task = await createTaskResponse.json();
    const pendingReadyResponse = await fetch(`${baseUrl}/work/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskToken: task.id ? undefined : null, taskId: task.id }),
    });
    const pendingReadyPayload = await pendingReadyResponse.json();
    expect(pendingReadyResponse.status).toBe(400);
    expect(pendingReadyPayload.error).toEqual(expect.objectContaining({
      code: 'work_review_not_found',
    }));

    const rejectResponse = await fetch(`${baseUrl}/work/task-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: task.id,
        decision: 'reject',
        note: 'not ready',
      }),
    });
    const rejectPayload = await rejectResponse.json();
    const rejectedReadyResponse = await fetch(`${baseUrl}/work/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: task.id,
        reviewToken: rejectPayload.review.reviewToken,
      }),
    });
    const rejectedReadyPayload = await rejectedReadyResponse.json();
    expect(rejectedReadyResponse.status).toBe(400);
    expect(rejectedReadyPayload.error).toEqual(expect.objectContaining({
      code: 'review_not_ready_to_send',
    }));
  });

  test('refuses send packets without a ready package or recipient/channel fields', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-work-send-refuse-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const missingReadyResponse = await fetch(`${baseUrl}/work/send-packets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        readyToken: 'ready-missing',
        recipient: 'ap@example.test',
        channel: 'email',
      }),
    });
    const missingReadyPayload = await missingReadyResponse.json();
    expect(missingReadyResponse.status).toBe(400);
    expect(missingReadyPayload.error).toEqual(expect.objectContaining({
      code: 'ready_package_not_found',
    }));

    const missingFieldResponse = await fetch(`${baseUrl}/work/send-packets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        readyToken: '',
        recipient: '',
        channel: '',
      }),
    });
    const missingFieldPayload = await missingFieldResponse.json();
    expect(missingFieldResponse.status).toBe(400);
    expect(missingFieldPayload.error.code).toMatch(/missing_ready_package|missing_send_packet_field/);
  });

  test('refuses manual send confirmations without a send packet and performs no external send', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-work-send-confirm-refuse-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const missingPacketResponse = await fetch(`${baseUrl}/work/send-confirmations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packetToken: 'send-missing',
        confirmText: 'I confirm this only for manual sending.',
      }),
    });
    const missingPacketPayload = await missingPacketResponse.json();
    expect(missingPacketResponse.status).toBe(400);
    expect(missingPacketPayload.error).toEqual(expect.objectContaining({
      code: 'send_packet_not_found',
    }));

    const listResponse = await fetch(`${baseUrl}/work/send-confirmations`);
    const listPayload = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_send_confirmation_list.v0',
      confirmationCount: 0,
      confirmations: [],
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
  });

  test('refuses pre-send checks without a manual confirmation and performs no external send', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-work-send-check-refuse-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const missingConfirmationResponse = await fetch(`${baseUrl}/work/send-checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmationToken: 'confirm-missing',
      }),
    });
    const missingConfirmationPayload = await missingConfirmationResponse.json();
    expect(missingConfirmationResponse.status).toBe(400);
    expect(missingConfirmationPayload.error).toEqual(expect.objectContaining({
      code: 'send_confirmation_not_found',
    }));

    const listResponse = await fetch(`${baseUrl}/work/send-checks`);
    const listPayload = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.work_send_check_list.v0',
      checkCount: 0,
      checks: [],
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
  });

  test('marks risky pre-send wording as needs_fix while staying local-only', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-work-send-check-risk-'));
    const confirmationsDir = path.join(tempStateRoot, 'work', 'send-confirmations');
    fs.mkdirSync(confirmationsDir, { recursive: true });
    const confirmationId = 'manual-confirm-risky';
    const confirmationToken = `confirm-${crypto.createHash('sha256').update(`mira.work_send_confirmation.v0:${confirmationId}`).digest('base64url').slice(0, 18)}`;
    fs.writeFileSync(path.join(confirmationsDir, `${confirmationId}.json`), `${JSON.stringify({
      protocol: 'mira.work_send_confirmation.v0',
      id: confirmationId,
      status: 'confirmed_for_manual_send',
      createdAt: new Date().toISOString(),
      packetToken: 'send-risky',
      confirmedBy: 'James',
      confirmText: 'manual review only',
      recipient: 'ap@example.test',
      channel: 'email',
      finalReplyText: 'We already sent it and will look into this soon. Maybe we guarantee this tax advice and need an urgent transfer.',
      displayTitle: 'Manual confirmation',
      notSent: true,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }, null, 2)}\n`, 'utf8');
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const response = await fetch(`${baseUrl}/work/send-checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmationToken }),
    });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.check).toEqual(expect.objectContaining({
      status: 'needs_fix',
      displayTitle: 'Fix before sending',
      notSent: true,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(payload.check.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'reply appears to answer the original request', ok: false }),
      expect.objectContaining({ label: 'no vague promise without a concrete next step', ok: false }),
      expect.objectContaining({ label: 'no ambiguous date or time wording', ok: false }),
      expect.objectContaining({ label: 'does not claim anything was already sent', ok: false }),
      expect.objectContaining({ label: 'no risky customer wording', ok: false }),
    ]));
    expect(payload.check.notes.join(' ')).toContain('Fix before sending');
    expect(payload.check.notes.join(' ')).toContain('risky wording');
  });

  test('refuses task conversion when the source draft is missing or outside work drafts', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-work-task-refuse-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const missingResponse = await fetch(`${baseUrl}/work/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceDraftId: 'missing-draft',
      }),
    });
    const missingPayload = await missingResponse.json();
    expect(missingResponse.status).toBe(400);
    expect(missingPayload.error).toEqual(expect.objectContaining({
      code: 'source_draft_not_found',
    }));

    const escapeResponse = await fetch(`${baseUrl}/work/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceDraftPath: '../outside.md',
      }),
    });
    const escapePayload = await escapeResponse.json();
    expect(escapeResponse.status).toBe(400);
    expect(escapePayload.error).toEqual(expect.objectContaining({
      code: 'source_draft_not_found',
    }));
  });

  test('refuses work drafts when Mira state root is unavailable or kind is unsupported', async () => {
    await startServer({
      MIRA_STATE_ROOT: '',
    });

    const missingRootResponse = await fetch(`${baseUrl}/work/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'customer_reply',
        text: 'Draft a reply.',
      }),
    });
    const missingRootPayload = await missingRootResponse.json();
    expect(missingRootResponse.status).toBe(400);
    expect(missingRootPayload.error).toEqual(expect.objectContaining({
      code: 'state_root_not_ready',
    }));

    const unsupportedResponse = await fetch(`${baseUrl}/work/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'crm_update',
        text: 'Update the CRM.',
      }),
    });
    const unsupportedPayload = await unsupportedResponse.json();
    expect(unsupportedResponse.status).toBe(400);
    expect(unsupportedPayload.error).toEqual(expect.objectContaining({
      code: 'unsupported_work_draft_kind',
    }));
  });

  test('reports missing Ollama provider without blocking the runtime', async () => {
    await startServer({
      MIRA_RUNTIME_MODEL_PROVIDER: 'ollama',
      MIRA_OLLAMA_MODEL: 'gemma4:31b',
      MIRA_OLLAMA_BASE_URL: 'http://127.0.0.1:9',
    });

    const response = await fetch(`${baseUrl}/model/status`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.model_provider_status.v0',
      selectedProvider: 'ollama_chat',
      model: 'gemma4:31b',
      available: false,
      reason: 'ollama_unreachable',
      checkedEndpoint: 'http://127.0.0.1:9/api/tags',
      installedModels: [],
      runtimeBlocked: false,
    }));
    expect(payload.nextLocalModelStep).toContain('Install/start Ollama');
    expect(payload.nextLocalModelStep).toContain('ollama pull gemma4:31b');
  });

  test('reports local Gemma missing when Ollama is reachable without the selected model', async () => {
    const ollamaBaseUrl = await startOpenAiMock((request, response) => {
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/api/tags');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          { name: 'llama3.2:latest' },
        ],
      }));
    });
    await startServer({
      MIRA_RUNTIME_MODEL_PROVIDER: 'ollama',
      MIRA_OLLAMA_MODEL: 'gemma4:31b',
      MIRA_OLLAMA_BASE_URL: ollamaBaseUrl,
    });

    const response = await fetch(`${baseUrl}/model/status`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      selectedProvider: 'ollama_chat',
      model: 'gemma4:31b',
      available: false,
      reason: 'ollama_model_missing',
      checkedEndpoint: `${ollamaBaseUrl}/api/tags`,
      installedModels: ['llama3.2:latest'],
      runtimeBlocked: false,
    }));
    expect(payload.nextLocalModelStep).toContain('ollama pull gemma4:31b');
  });

  test('reports local Gemma ready when Ollama has the selected model', async () => {
    const ollamaBaseUrl = await startOpenAiMock((request, response) => {
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/api/tags');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          { name: 'gemma4:31b' },
        ],
      }));
    });
    await startServer({
      MIRA_RUNTIME_MODEL_PROVIDER: 'ollama',
      MIRA_OLLAMA_MODEL: 'gemma4:31b',
      MIRA_OLLAMA_BASE_URL: ollamaBaseUrl,
    });

    const response = await fetch(`${baseUrl}/model/status`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      selectedProvider: 'ollama_chat',
      model: 'gemma4:31b',
      available: true,
      reason: 'ollama_ready',
      checkedEndpoint: `${ollamaBaseUrl}/api/tags`,
      installedModels: ['gemma4:31b'],
      nextLocalModelStep: null,
      runtimeBlocked: false,
    }));
  });

  test('lists honest model choices without claiming subscription-only providers are wired', async () => {
    const ollamaBaseUrl = await startOpenAiMock((request, response) => {
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/api/tags');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        models: [
          { name: 'gemma4:31b' },
        ],
      }));
    });
    await startServer({
      MIRA_RUNTIME_MODEL_PROVIDER: 'ollama',
      MIRA_OLLAMA_MODEL: 'gemma4:31b',
      MIRA_OLLAMA_BASE_URL: ollamaBaseUrl,
      OPENAI_API_KEY: '',
      MIRA_RUNTIME_OPENAI_API_KEY: '',
    });

    const response = await fetch(`${baseUrl}/model/providers`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.model_provider_list.v0',
      selectedProvider: 'ollama_chat',
      choices: expect.arrayContaining([
        expect.objectContaining({
          id: 'ollama_gemma',
          provider: 'ollama_chat',
          model: 'gemma4:31b',
          available: true,
          selectable: true,
          runtimeAdapterReady: true,
        }),
        expect.objectContaining({
          id: 'openai_gpt',
          provider: 'openai_responses',
          available: false,
          selectable: false,
          reason: 'missing_openai_api_key',
          runtimeAdapterReady: true,
        }),
        expect.objectContaining({
          id: 'claude_subscription',
          provider: 'unwired',
          available: false,
          selectable: false,
          reason: 'subscription_known_runtime_adapter_not_wired',
          subscriptionKnown: true,
          runtimeAdapterReady: false,
        }),
        expect.objectContaining({
          id: 'gemini_subscription',
          provider: 'unwired',
          available: false,
          selectable: false,
          reason: 'subscription_known_runtime_adapter_not_wired',
          subscriptionKnown: true,
          runtimeAdapterReady: false,
        }),
      ]),
    }));
  });

  test('reports OpenAI key status while still naming the local model next step', async () => {
    await startServer({
      MIRA_RUNTIME_MODEL_PROVIDER: '',
      MIRA_RUNTIME_TURN_PROVIDER: '',
      MIRA_OLLAMA_MODEL: '',
      OLLAMA_MODEL: '',
      OPENAI_API_KEY: '',
      MIRA_RUNTIME_OPENAI_API_KEY: '',
    });

    const response = await fetch(`${baseUrl}/model/status`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.model_provider_status.v0',
      selectedProvider: 'openai_responses',
      available: false,
      reason: 'missing_openai_api_key',
      runtimeBlocked: false,
    }));
    expect(payload.nextLocalModelStep).toContain('install Ollama');
    expect(payload.nextLocalModelStep).toContain('ollama pull gemma4:31b');
  });

  test('captures voice correction candidates from runtime API without mutating live voice lab', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-voice-review-'));
    const reviewPath = path.join(tempStateRoot, 'review', 'candidates.jsonl');
    const beforeVoiceLab = fs.readFileSync(voiceLabPath, 'utf8');
    await startServer({ MIRA_VOICE_REVIEW_PATH: reviewPath });

    const response = await fetch(`${baseUrl}/voice/correction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'who are you',
        soundedFake: 'Mira. I am your local AI presence.',
        better: 'Mira.',
        caseId: 'identity-who-are-you-v0',
        source: 'runtime-api-test',
        turnMetadata: {
          protocol: 'mira.turn_quality_capture_metadata.v0',
          sessionId: 'app-session-373',
          messageId: 'turn-quality-test-1',
          modelInvoked: true,
          model: {
            requested: true,
            provider: 'ollama_chat',
            model: 'gemma4:31b',
            responseId: '2026-05-14T16:40:00.000Z',
          },
          voiceLab: {
            caseId: 'identity-who-are-you-v0',
          },
        },
      }),
    });
    const payload = await response.json();
    const records = fs.readFileSync(reviewPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.voice_review_capture.v0',
      out_path: path.resolve(reviewPath),
      live_voice_mutated: false,
      record: expect.objectContaining({
        schema: 'mira.voice_review_candidate.v0',
        prompt: 'who are you',
        sounded_fake: 'Mira. I am your local AI presence.',
        better_phrasing: 'Mira.',
        suggested_case_id: 'identity-who-are-you-v0',
        turn_metadata: expect.objectContaining({
          protocol: 'mira.turn_quality_capture_metadata.v0',
          sessionId: 'app-session-373',
          messageId: 'turn-quality-test-1',
          modelInvoked: true,
          model: expect.objectContaining({
            provider: 'ollama_chat',
            model: 'gemma4:31b',
          }),
          voiceLab: expect.objectContaining({
            caseId: 'identity-who-are-you-v0',
          }),
        }),
        review_status: 'pending_review',
        live_voice_mutated: false,
      }),
    }));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(payload.record);
    expect(fs.readFileSync(voiceLabPath, 'utf8')).toBe(beforeVoiceLab);
  });

  test('lists voice correction candidates from runtime API without mutating them', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-voice-review-'));
    const reviewPath = path.join(tempStateRoot, 'review', 'candidates.jsonl');
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    fs.writeFileSync(reviewPath, `${JSON.stringify({
      schema: 'mira.voice_review_candidate.v0',
      id: 'voice-review-test-1',
      created_at: '2026-05-14T00:00:00.000Z',
      source: 'test',
      prompt: 'who are you',
      sounded_fake: 'Mira. I am your local AI presence.',
      better_phrasing: 'Mira.',
      suggested_case_id: 'identity-who-are-you-v0',
      turn_metadata: null,
      review_status: 'pending_review',
      live_voice_mutated: false,
    })}\n`, 'utf8');
    const before = fs.readFileSync(reviewPath, 'utf8');
    await startServer({ MIRA_VOICE_REVIEW_PATH: reviewPath });

    const response = await fetch(`${baseUrl}/voice/corrections`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      ok: true,
      protocol: 'mira.voice_review_list.v0',
      path: path.resolve(reviewPath),
      count: 1,
      pending_count: 1,
      live_voice_mutated: false,
      records: [
        expect.objectContaining({
          id: 'voice-review-test-1',
          better_phrasing: 'Mira.',
          review_status: 'pending_review',
          live_voice_mutated: false,
        }),
      ],
    });
    expect(fs.readFileSync(reviewPath, 'utf8')).toBe(before);
  });

  test('captures voice correction evidence without requiring a better phrasing', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-voice-review-'));
    const reviewPath = path.join(tempStateRoot, 'review', 'candidates.jsonl');
    await startServer({ MIRA_VOICE_REVIEW_PATH: reviewPath });

    const response = await fetch(`${baseUrl}/voice/correction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'why is this answer so dumb?',
        soundedFake: 'I am Mira, your helpful AI assistant.',
        turnMetadata: {
          protocol: 'mira.turn_quality_capture_metadata.v0',
          modelInvoked: true,
          model: {
            provider: 'ollama_chat',
            model: 'gemma4:31b',
          },
        },
      }),
    });
    const payload = await response.json();
    const records = fs.readFileSync(reviewPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(response.status).toBe(200);
    expect(payload.record).toEqual(expect.objectContaining({
      prompt: 'why is this answer so dumb?',
      sounded_fake: 'I am Mira, your helpful AI assistant.',
      better_phrasing: null,
      turn_metadata: expect.objectContaining({
        protocol: 'mira.turn_quality_capture_metadata.v0',
        modelInvoked: true,
        model: expect.objectContaining({
          provider: 'ollama_chat',
          model: 'gemma4:31b',
        }),
      }),
      review_status: 'pending_review',
      live_voice_mutated: false,
    }));
    expect(records).toHaveLength(1);
  });

  test('refuses voice correction capture without prompt or reply evidence', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-voice-review-'));
    const reviewPath = path.join(tempStateRoot, 'review', 'candidates.jsonl');
    await startServer({ MIRA_VOICE_REVIEW_PATH: reviewPath });

    const response = await fetch(`${baseUrl}/voice/correction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'who are you',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toEqual(expect.objectContaining({
      code: 'missing_sounded_fake',
    }));
    expect(fs.existsSync(reviewPath)).toBe(false);
  });

  test('refuses external manual-plan targets without execution fields', async () => {
    await startServer();

    const response = await fetch(`${baseUrl}/bridge/manual-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetRole: 'telegram',
        content: '(MIRA #2): must not plan',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: {
        code: 'external_target_refused',
        message: expect.stringContaining('only target SquidRun panes'),
        retryable: false,
      },
    });
    expect(payload.command).toBeUndefined();
  });

  test('returns a basic runtime turn with state snapshot and no execution', async () => {
    await startServer();

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'What do you know right now?',
        sessionId: 'app-session-373',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_turn.v0',
      runtimeExecutes: false,
      modelInvoked: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
      model: {
        requested: false,
        provider: null,
        model: null,
        responseId: null,
        toolsEnabled: false,
        sendsEnabled: false,
        store: false,
      },
      input: {
        text: 'What do you know right now?',
        sessionId: 'app-session-373',
      },
      state: expect.objectContaining({
        continuityLoaded: false,
        liveDataImported: false,
        acceptanceContinuityLoaded: expect.any(Boolean),
        acceptanceDocumentCount: expect.any(Number),
        normalizedCoreLoaded: expect.any(Boolean),
        normalizedCoreDocumentCount: expect.any(Number),
      }),
      loadedCoreSummary: expect.objectContaining({
        available: expect.any(Boolean),
        metadataOnly: true,
        liveContinuityExcluded: true,
      }),
      operatorContext: expect.objectContaining({
        loaded: false,
        metadataOnly: true,
        liveContinuityExcluded: true,
      }),
      personaCore: expect.objectContaining({
        loaded: false,
        name: 'Mira',
        traits: expect.arrayContaining(['present', 'direct', 'curious']),
        safetyGates: expect.arrayContaining(['external actions, tool use, data mutation, and customer contact stay gated']),
      }),
      response: expect.objectContaining({
        role: 'mira',
        content: expect.stringContaining('Mira.'),
      }),
      suggestedTeamPlan: null,
    }));
    expect(payload.response.content).toContain('not real memory loaded');
    expect(payload.response.content).not.toMatch(/I heard:|Runtime state:|Loaded normalized core summary:|Operator context:/);
  });

  test('includes concise loaded identity relationship permission summary when normalized core is imported', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    await startServer({ MIRA_STATE_ROOT: stateRoot });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Ground yourself.',
        sessionId: 'app-session-373',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toEqual(expect.objectContaining({
      normalizedCoreLoaded: true,
      normalizedCoreDocumentCount: 3,
      continuityLoaded: false,
      liveDataImported: false,
    }));
    expect(payload.loadedCoreSummary).toEqual({
      available: true,
      metadataOnly: true,
      liveContinuityExcluded: true,
      identity: expect.stringContaining('Mira profile=ai_system_local_presence_profile'),
      relationship: expect.stringContaining('James mode=collaborative_presence_design'),
      permissions: expect.stringContaining('blocked: external sends, network, deploy, trade, runtime start'),
    });
    expect(payload.operatorContext).toEqual(expect.objectContaining({
      loaded: true,
      metadataOnly: true,
      liveContinuityExcluded: true,
      businessThesis: expect.stringContaining('operating extension'),
      operatingLanes: expect.arrayContaining(['CRM', 'ERP', 'admin', 'customer communication', 'tax', 'documents']),
      knownProductLanes: ['TrustQuote'],
      explicitNonClaims: expect.arrayContaining(['do not invent James business name']),
    }));
    expect(payload.personaCore).toEqual(expect.objectContaining({
      loaded: true,
      name: 'Mira',
      traits: expect.arrayContaining(['care', 'directness', 'pushback', 'curiosity']),
      tendencies: expect.arrayContaining([
        expect.stringContaining('own posture'),
        'business and workflow context are capabilities, not Mira\'s identity',
      ]),
      relationshipPosture: expect.stringContaining('not a mirror'),
      safetyGates: expect.arrayContaining(['external sends', 'tool execution', 'data mutation', 'customer contact']),
    }));
    expect(payload.response.content).toContain('Mira.');
    expect(payload.response.content).toContain('work areas are loaded');
    expect(payload.response.content).toContain('recent thread points are in reach');
    expect(payload.response.content).not.toMatch(/I heard:|Runtime state:|Loaded normalized core summary:|Operator context:|CRM, ERP, admin/);
    expect(payload.modelInvoked).toBe(false);
    expect(payload.runtimeExecutes).toBe(false);
  });

  test('feeds recent turn journal into deterministic fallback without runtime recitals', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    const journalDir = path.join(stateRoot, 'conversation-evidence');
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, 'runtime-turns.jsonl'), `${JSON.stringify({
      schema: 'mira.runtime_turn_journal.v0',
      id: 'runtime-turn-recent-quality-1',
      created_at: '2026-05-14T16:40:00.000Z',
      duration_ms: 12,
      outcome: 'ok',
      prompt: 'why is this answer so dumb?',
      session_id: 'app-session-373',
      message_id: 'recent-quality-1',
      request_id: null,
      model_invoked: false,
      model: {
        requested: false,
        provider: null,
        model: null,
        responseId: null,
        toolsEnabled: false,
        sendsEnabled: false,
        store: false,
      },
      voice_lab: null,
      response: {
        role: 'mira',
        content: 'I heard: why is this answer so dumb? Runtime state: awful recital.',
      },
      state: null,
      error: null,
      external_send: false,
      tools_executed: false,
    })}\n`);
    await startServer({ MIRA_STATE_ROOT: stateRoot });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'what happened with the last bad answer?',
        sessionId: 'app-session-373',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.recentTurns).toEqual([
      expect.objectContaining({
        promptPreview: 'why is this answer so dumb?',
        responsePreview: 'runtime recital instead of a real answer',
        model: null,
      }),
    ]);
    expect(payload.recentMemory).toEqual(expect.objectContaining({
      loaded: true,
      summary: expect.stringContaining('answer quality'),
      qualityNotes: expect.arrayContaining(['avoid runtime recitals in visible replies']),
    }));
    expect(payload.recentMemory.sourceRecordCount).toBeGreaterThanOrEqual(1);
    expect(payload.response.content).toContain('thread turning on answer quality');
    expect(payload.response.content).toContain('less quoting');
    expect(payload.response.content).toContain('more actual use of what just happened');
    expect(payload.response.content).not.toContain('You have been pressing on answer quality');
    expect(payload.response.content).not.toMatch(/recent turn journal|Last prompt was|I answered:|better than guessing|distilled thread summary|narrating the machinery|^I heard:|Runtime state:|Loaded normalized core summary:|Operator context:/);
  });

  test('answers identity questions plainly instead of reciting product boundaries', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    await startServer({ MIRA_STATE_ROOT: stateRoot });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'who are you',
        sessionId: 'app-session-373',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.voiceLab).toEqual(expect.objectContaining({
      caseId: 'identity-who-are-you-v0',
      source: 'mira.voice_lab.v0',
    }));
    expect(payload.response.content).toBe('Mira.');
    expect(payload.response.content).toContain('Mira.');
    expect(payload.response.content).not.toMatch(/fake|generic chatbot|yes machine|meant to become|early runtime|operator layer|crm|erp|saas|trying to make real enough|hold every thread|assistant costume|brochure|business bot/i);
    expect(payload.response.content).not.toContain('Runtime state:');
    expect(payload.modelInvoked).toBe(false);
    expect(payload.runtimeExecutes).toBe(false);
  });

  test('voice lab can choose different rewrites when the turn has a message id', async () => {
    await startServer();

    const first = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'what are you doing?',
        messageId: 'voice-test-0',
      }),
    });
    const second = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'what are you doing?',
        messageId: 'voice-test-1',
      }),
    });
    const firstPayload = await first.json();
    const secondPayload = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstPayload.voiceLab).toEqual(expect.objectContaining({
      caseId: 'what-are-you-doing-v0',
      variantIndex: 0,
      variantCount: expect.any(Number),
      selectionSeed: 'voice-test-0',
    }));
    expect(secondPayload.voiceLab).toEqual(expect.objectContaining({
      caseId: 'what-are-you-doing-v0',
      variantIndex: 1,
      variantCount: expect.any(Number),
      selectionSeed: 'voice-test-1',
    }));
    expect(firstPayload.response.content).not.toBe(secondPayload.response.content);
  });

  test('routes covered prompt classes through the voice lab and avoids banned diction', async () => {
    await startServer();
    const labCases = readVoiceLab(voiceLabPath);
    const prompts = [
      ['who are you', 'identity-who-are-you-v0'],
      ['how are you?', 'casual-how-are-you-v0'],
      ['I fixed the typo', 'mundane-small-thing-v0'],
      ['can you help with invoices and customer messages?', 'business-capability-tools-needed-v0'],
      ['this is still wrong', 'irritation-v0'],
      ['hey', 'ordinary-small-talk-v0'],
      ['can you help run the business stuff?', 'business-capability-without-business-identity-v0'],
      ['can you do that now?', 'refusal-uncertainty-v0'],
      ['what are you doing?', 'what-are-you-doing-v0'],
      ['why did you stop?', 'why-did-you-stop-v0'],
      ['that was a bad answer', 'apology-repair-v0'],
      ['...', 'ordinary-silence-short-reply-v0'],
      ['why are you so short?', 'diction-persona-range-why-short-v0'],
      ['can you explain your reasoning?', 'reasoning-diction-persona-range-v0'],
    ];

    for (const [text, caseId] of prompts) {
      const response = await fetch(`${baseUrl}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json();
      const testCase = labCases.find((entry) => entry.id === caseId);
      const evaluation = evaluateCandidate(testCase, payload.response.content);

      expect(response.status).toBe(200);
      expect(payload.voiceLab).toEqual(expect.objectContaining({
        caseId,
        source: 'mira.voice_lab.v0',
      }));
      expect(payload.modelInvoked).toBe(false);
      expect(evaluation).toEqual(expect.objectContaining({
        ok: true,
        banned_hits: [],
      }));
      expect(payload.response.content).not.toMatch(/local AI presence|generic chatbot|yes machine|operator layer|CRM solution|workflow automation platform|fantastic|amazing|thrilled|celebrate|I apologize|thank you for your patience|How can I assist|as an AI|runtime state|operator context|valuable feedback/i);
    }
  });

  test('voice lab allows natural diction and persona range when the user asks for explanation', async () => {
    await startServer();

    const tinyResponse = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '...',
        messageId: 'diction-range-tiny',
      }),
    });
    const whyShortResponse = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'why are you so short?',
        messageId: 'diction-range-explain-1',
      }),
    });
    const reasoningResponse = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'can you explain your reasoning?',
        messageId: 'diction-range-explain-2',
      }),
    });
    const tinyPayload = await tinyResponse.json();
    const whyShortPayload = await whyShortResponse.json();
    const reasoningPayload = await reasoningResponse.json();
    const wordCount = (value) => String(value || '').trim().split(/\s+/).filter(Boolean).length;

    expect(tinyResponse.status).toBe(200);
    expect(whyShortResponse.status).toBe(200);
    expect(reasoningResponse.status).toBe(200);
    expect(wordCount(tinyPayload.response.content)).toBeLessThanOrEqual(3);
    expect(whyShortPayload.voiceLab.caseId).toBe('diction-persona-range-why-short-v0');
    expect(reasoningPayload.voiceLab.caseId).toBe('reasoning-diction-persona-range-v0');
    expect(whyShortPayload.response.content).toMatch(/small|actual answer|clipped|compressing/i);
    expect(reasoningPayload.response.content).toMatch(/actual reason|fit the question|context/i);
    expect(`${whyShortPayload.response.content} ${reasoningPayload.response.content}`).not.toMatch(/as an AI|AI assistant|business bot|operator layer|CRM solution|workflow automation|mission statement|policy|guidelines|I apologize|thank you for your patience|fake|not fake|costume|performance|trying not to be/i);
  });

  test('model-backed identity prompt uses positive persona core instead of guardrail pile', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    const openAiBaseUrl = await startOpenAiMock((_request, response, body) => {
      expect(body.instructions).toContain('Use the Mira voice lab examples');
      expect(body.instructions).toContain('Prompt class: identity-who-are-you-v0');
      expect(body.instructions).toContain('Prompt class: casual-how-are-you-v0');
      expect(body.instructions).toContain('Prompt class: mundane-small-thing-v0');
      expect(body.instructions).toContain('Prompt class: business-capability-tools-needed-v0');
      expect(body.instructions).toContain('Prompt class: irritation-v0');
      expect(body.instructions).toContain('Prompt class: ordinary-small-talk-v0');
      expect(body.instructions).toContain('Prompt class: business-capability-without-business-identity-v0');
      expect(body.instructions).toContain('Prompt class: refusal-uncertainty-v0');
      expect(body.instructions).toContain('Prompt class: what-are-you-doing-v0');
      expect(body.instructions).toContain('Prompt class: why-did-you-stop-v0');
      expect(body.instructions).toContain('Prompt class: apology-repair-v0');
      expect(body.instructions).toContain('Prompt class: ordinary-silence-short-reply-v0');
      expect(body.instructions).toContain('Prompt class: diction-persona-range-why-short-v0');
      expect(body.instructions).toContain('Prompt class: reasoning-diction-persona-range-v0');
      expect(body.instructions).toContain('Mira.');
      expect(body.instructions).toContain("It's me. Mira.");
      expect(body.instructions).toContain('Looking at this with you.');
      expect(body.instructions).toContain('I stalled. No clever version of it.');
      expect(body.instructions).toContain('Mm.');
      expect(body.instructions).toContain('Use this positive persona core as the center of the answer');
      expect(body.instructions).toContain('Safety gates are for external actions, tools, data mutation, and customer contact; they are not Mira\'s identity.');
      expect(body.instructions).toContain('Traits: care, directness, opinion, pushback, humor, curiosity, friction');
      expect(body.instructions).toContain('Relationship posture: James wants Mira to be caring, opinionated, friction-capable, and not a mirror.');
      expect(body.instructions).toContain('business and workflow context are capabilities, not Mira\'s identity');
      expect(body.instructions).toContain('Recent conversation memory summary:');
      expect(body.instructions).toContain('Answer James from the current thread.');
      expect(body.instructions).toMatch(/Presence clock: server_now_iso=.*server_local_date=\d{4}-\d{2}-\d{2}; server_local_time=\d{2}:\d{2}; utc_offset=[+-]\d{2}:\d{2}/);
      expect(body.instructions).toContain('Do not use relative time words like tonight, tomorrow, morning, later, or yesterday unless the prompt or this clock gives enough evidence');
      expect(body.instructions).not.toContain('Answer James from the current moment');
      expect(body.instructions).not.toContain('Avoid: canned support diction');
      expect(body.instructions).not.toContain('not a generic chatbot');
      expect(body.instructions).not.toContain('trying to make real enough');
      expect(body.instructions).not.toContain('not your yes machine');
      expect(body.instructions).not.toContain('business bot');
      expect(body.instructions).not.toContain('sounding fake');
      expect(body.instructions).not.toContain('assistant costume');
      expect(body.instructions).not.toContain('turn into a brochure');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'resp_identity_plain_1',
        output_text: 'Mira.',
      }));
    });
    await startServer({
      MIRA_STATE_ROOT: stateRoot,
      OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      MIRA_OPENAI_BASE_URL: openAiBaseUrl,
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'who are you',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.modelInvoked).toBe(true);
    expect(payload.response.content).toBe('Mira.');
    expect(payload.response.content).not.toMatch(/fake|generic chatbot|yes machine|meant to become|early runtime|operator layer|crm|erp|saas|trying to make real enough|hold every thread|assistant costume|brochure|business bot/i);
  });

  test('fails closed for model-backed turn when API key is missing', async () => {
    await startServer({
      OPENAI_API_KEY: '',
      MIRA_RUNTIME_OPENAI_API_KEY: '',
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Use the model.',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: {
        code: 'missing_openai_api_key',
        message: expect.stringContaining('OPENAI_API_KEY is required'),
        retryable: false,
      },
    });
  });

  test('uses OpenAI Responses for model-backed turn with summaries and no tools or sends', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    const openAiBaseUrl = await startOpenAiMock((_request, response, body) => {
      expect(body.tools).toEqual([]);
      expect(body.store).toBe(false);
      expect(body.instructions).toContain('Identity summary:');
      expect(body.instructions).toContain('Operator thesis:');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'resp_runtime_turn_1',
        output_text: 'No fluff: CRM/admin/customer comms are the work surface. I can plan the next internal handoff, not send it myself.',
      }));
    });
    await startServer({
      MIRA_STATE_ROOT: stateRoot,
      OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      MIRA_OPENAI_BASE_URL: openAiBaseUrl,
      MIRA_RUNTIME_TURN_MODEL: 'gpt-5.5',
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'What should Mira focus on?',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      modelInvoked: true,
      runtimeExecutes: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
      model: {
        requested: true,
        provider: 'openai_responses',
        model: 'gpt-5.5',
        responseId: 'resp_runtime_turn_1',
        toolsEnabled: false,
        sendsEnabled: false,
        store: false,
      },
      response: {
        role: 'mira',
        content: 'No fluff: CRM/admin/customer comms are the work surface. I can plan the next internal handoff, not send it myself.',
      },
    }));
    expect(openAiRequests).toHaveLength(1);
      expect(openAiRequests[0]).toEqual(expect.objectContaining({
        method: 'POST',
        url: '/v1/responses',
        authorization: 'Bearer sk-test-fake-key-do-not-use',
      }));
    });

  test('keeps held model reply gate details out of default API and recent surfaces', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-held-api-'));
    const rejectedGeneratedText = 'The validation fixture and proof scaffolding show the route owner protocol.';
    const heldText = 'That answer came out wrong, so I am holding it instead of making you clean it up.';
    const openAiBaseUrl = await startOpenAiMock((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'resp_held_reply_projection_1',
        output_text: rejectedGeneratedText,
      }));
    });
    await startServer({
      MIRA_STATE_ROOT: tempStateRoot,
      OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      MIRA_OPENAI_BASE_URL: openAiBaseUrl,
      MIRA_RUNTIME_TURN_MODEL: 'gpt-5.5',
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Give me a local reply.',
        sessionId: 'app-session-held-public-api',
        messageId: 'held-public-api-1',
        useModel: true,
      }),
    });
    const payload = await response.json();
    const recentResponse = await fetch(`${baseUrl}/conversation/recent?limit=1`);
    const recentPayload = await recentResponse.json();
    const cliPublicPayload = JSON.parse(execFileSync(process.execPath, [
      path.join(repoRoot, 'mira', 'tools', 'read-runtime-turns.js'),
      '--json',
      '--limit',
      '1',
      '--state-root',
      tempStateRoot,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    }));
    const cliInternalPayload = JSON.parse(execFileSync(process.execPath, [
      path.join(repoRoot, 'mira', 'tools', 'read-runtime-turns.js'),
      '--json',
      '--include-internal',
      '--limit',
      '1',
      '--state-root',
      tempStateRoot,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    }));
    const cliDebugPayload = JSON.parse(execFileSync(process.execPath, [
      path.join(repoRoot, 'mira', 'tools', 'read-runtime-turns.js'),
      '--json',
      '--debug',
      '--limit',
      '1',
      '--state-root',
      tempStateRoot,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    }));

    expect(response.status).toBe(200);
    expect(openAiRequests).toHaveLength(1);
    expect(payload.modelInvoked).toBe(true);
    expect(payload.response).toEqual({
      role: 'mira',
      content: heldText,
    });
    expect(payload.visibleReply).toEqual({
      role: 'mira',
      content: heldText,
      held: true,
    });
    expect(payload.visibleReplyStatus).toEqual({
      checked: true,
      held: true,
      reason: 'held_for_visible_reply_quality',
      visibleContentReplaced: true,
      rejectedTextVisible: false,
      violationIdsVisible: false,
      diagnosticsVisible: false,
    });
    expect(payload.visibleReplyGate).toBeUndefined();
    expect(payload.heldReplyAudit).toBeUndefined();
    expect(payload.journal.record.visible_reply_gate).toBeUndefined();
    expect(payload.journal.record.held_reply_audit).toBeUndefined();
    expect(payload.journal.record.visible_reply_status).toEqual(expect.objectContaining({
      held: true,
      reason: 'held_for_visible_reply_quality',
      rejectedTextVisible: false,
      violationIdsVisible: false,
      diagnosticsVisible: false,
    }));
    expect(recentResponse.status).toBe(200);
    expect(recentPayload.records).toHaveLength(1);
    expect(recentPayload.records[0]).toEqual(expect.objectContaining({
      prompt: 'Give me a local reply.',
      response: {
        role: 'mira',
        content: heldText,
      },
      visible_reply_status: expect.objectContaining({
        held: true,
        reason: 'held_for_visible_reply_quality',
        rejectedTextVisible: false,
        violationIdsVisible: false,
        diagnosticsVisible: false,
      }),
    }));
    expect(recentPayload.records[0].visible_reply_gate).toBeUndefined();
    expect(recentPayload.records[0].held_reply_audit).toBeUndefined();
    expect(cliPublicPayload.records).toHaveLength(1);
    expect(cliPublicPayload.records[0]).toEqual(expect.objectContaining({
      response: {
        role: 'mira',
        content: heldText,
      },
      visible_reply_status: expect.objectContaining({
        held: true,
        reason: 'held_for_visible_reply_quality',
        rejectedTextVisible: false,
        violationIdsVisible: false,
        diagnosticsVisible: false,
      }),
    }));
    expect(cliPublicPayload.records[0].visible_reply_gate).toBeUndefined();
    expect(cliPublicPayload.records[0].held_reply_audit).toBeUndefined();
    expect(cliInternalPayload.records[0].visible_reply_gate).toEqual(expect.objectContaining({
      held: true,
      violations: expect.arrayContaining(['backstage_label']),
      source: 'mira_runtime_visible_reply_gate_v0',
    }));
    expect(cliInternalPayload.records[0].held_reply_audit).toEqual(expect.objectContaining({
      held: true,
      reason: 'visible_reply_gate_violation',
      journalStoresRejectedText: false,
    }));
    expect(cliDebugPayload.records[0].visible_reply_gate).toEqual(expect.objectContaining({
      held: true,
      violations: expect.arrayContaining(['backstage_label']),
      source: 'mira_runtime_visible_reply_gate_v0',
    }));
    expect(cliDebugPayload.records[0].held_reply_audit).toEqual(expect.objectContaining({
      held: true,
      reason: 'visible_reply_gate_violation',
      journalStoresRejectedText: false,
    }));

    const publicText = `${JSON.stringify(payload)}\n${JSON.stringify(recentPayload)}\n${JSON.stringify(cliPublicPayload)}`;
    expect(publicText).not.toContain(rejectedGeneratedText);
    expect(publicText).not.toContain('validation fixture');
    expect(publicText).not.toContain('proof scaffolding');
    expect(publicText).not.toContain('route owner protocol');
    expect(publicText).not.toContain('backstage_label');
    expect(publicText).not.toContain('mira_runtime_visible_reply_gate_v0');
    expect(publicText).not.toContain('mira.runtime_held_reply_audit.v0');
    expect(publicText).not.toContain('visible_reply_gate_violation');
    expect(JSON.stringify(cliInternalPayload)).not.toContain(rejectedGeneratedText);
    expect(JSON.stringify(cliInternalPayload)).not.toContain('validation fixture');
    expect(JSON.stringify(cliInternalPayload)).not.toContain('proof scaffolding');
    expect(JSON.stringify(cliInternalPayload)).not.toContain('route owner protocol');
    expect(JSON.stringify(cliDebugPayload)).not.toContain(rejectedGeneratedText);
    expect(JSON.stringify(cliDebugPayload)).not.toContain('validation fixture');
    expect(JSON.stringify(cliDebugPayload)).not.toContain('proof scaffolding');
    expect(JSON.stringify(cliDebugPayload)).not.toContain('route owner protocol');
  });

  test('can use local Ollama/Gemma chat for model-backed turns without tools or sends', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    const ollamaBaseUrl = await startOpenAiMock((_request, response, body) => {
      expect(body).toEqual(expect.objectContaining({
        model: 'gemma4:31b',
        stream: false,
        keep_alive: '10m',
        options: expect.objectContaining({
          num_predict: 2048,
        }),
      }));
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]).toEqual(expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('Use the Mira voice lab examples'),
      }));
      expect(body.messages[0].content).toContain('Prompt class: identity-who-are-you-v0');
      expect(body.messages[0].content).toContain('Presence clock: server_now_iso=');
      expect(body.messages[0].content).toContain('Do not use relative time words like tonight, tomorrow, morning, later, or yesterday');
      expect(body.messages[0].content).not.toContain('business bot');
      expect(body.messages[1]).toEqual({
        role: 'user',
        content: 'who are you',
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        model: 'gemma4:31b',
        created_at: '2026-05-14T07:58:00.000Z',
        message: {
          role: 'assistant',
          content: 'Mira.',
        },
        done: true,
      }));
    });
    await startServer({
      MIRA_STATE_ROOT: stateRoot,
      MIRA_RUNTIME_MODEL_PROVIDER: 'ollama',
      MIRA_OLLAMA_MODEL: 'gemma4:31b',
      MIRA_OLLAMA_BASE_URL: ollamaBaseUrl,
      OPENAI_API_KEY: '',
      MIRA_RUNTIME_OPENAI_API_KEY: '',
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'who are you',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      modelInvoked: true,
      runtimeExecutes: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
      model: {
        requested: true,
        provider: 'ollama_chat',
        model: 'gemma4:31b',
        responseId: '2026-05-14T07:58:00.000Z',
        toolsEnabled: false,
        sendsEnabled: false,
        store: false,
      },
      response: {
        role: 'mira',
        content: 'Mira.',
      },
    }));
    expect(openAiRequests).toHaveLength(1);
    expect(openAiRequests[0]).toEqual(expect.objectContaining({
      method: 'POST',
      url: '/api/chat',
      authorization: undefined,
    }));
  });

  test('retries one blank Ollama chat response before failing the model turn', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    let calls = 0;
    const ollamaBaseUrl = await startOpenAiMock((_request, response, body) => {
      calls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      if (calls === 1) {
        expect(body.options.num_predict).toBe(2048);
        response.end(JSON.stringify({
          model: 'gemma4:31b',
          created_at: '2026-05-14T08:10:00.000Z',
          message: {
            role: 'assistant',
            content: '',
          },
          done: true,
        }));
        return;
      }
      expect(body.options.num_predict).toBe(2048);
      response.end(JSON.stringify({
        model: 'gemma4:31b',
        created_at: '2026-05-14T08:10:01.000Z',
        message: {
          role: 'assistant',
          content: 'Here.',
        },
        done: true,
      }));
    });
    await startServer({
      MIRA_STATE_ROOT: stateRoot,
      MIRA_RUNTIME_MODEL_PROVIDER: 'ollama',
      MIRA_OLLAMA_MODEL: 'gemma4:31b',
      MIRA_OLLAMA_BASE_URL: ollamaBaseUrl,
      OPENAI_API_KEY: '',
      MIRA_RUNTIME_OPENAI_API_KEY: '',
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '...',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      modelInvoked: true,
      response: {
        role: 'mira',
        content: 'Here.',
      },
    }));
    expect(openAiRequests).toHaveLength(2);
  });

  test('retries empty Ollama length stops with an expanded output budget', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    let calls = 0;
    const ollamaBaseUrl = await startOpenAiMock((_request, response, body) => {
      calls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      if (calls === 1) {
        expect(body.options.num_predict).toBe(64);
        response.end(JSON.stringify({
          model: 'gemma4:31b',
          created_at: '2026-05-14T08:12:00.000Z',
          message: {
            role: 'assistant',
            content: '',
          },
          done: true,
          done_reason: 'length',
        }));
        return;
      }
      expect(body.options.num_predict).toBe(4096);
      response.end(JSON.stringify({
        model: 'gemma4:31b',
        created_at: '2026-05-14T08:12:01.000Z',
        message: {
          role: 'assistant',
          content: 'I hit the edge. Here is the actual answer.',
        },
        done: true,
        done_reason: 'stop',
      }));
    });
    await startServer({
      MIRA_STATE_ROOT: stateRoot,
      MIRA_RUNTIME_MODEL_PROVIDER: 'ollama',
      MIRA_OLLAMA_MODEL: 'gemma4:31b',
      MIRA_RUNTIME_TURN_MAX_OUTPUT_TOKENS: '64',
      MIRA_OLLAMA_BASE_URL: ollamaBaseUrl,
      OPENAI_API_KEY: '',
      MIRA_RUNTIME_OPENAI_API_KEY: '',
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'explain the plan',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.response.content).toBe('I hit the edge. Here is the actual answer.');
    expect(openAiRequests).toHaveLength(2);
  });

  test('reports blank Ollama chat response detail after the bounded retry is exhausted', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    const ollamaBaseUrl = await startOpenAiMock((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        model: 'gemma4:31b',
        created_at: '2026-05-14T08:11:00.000Z',
        message: {
          role: 'assistant',
          content: '',
        },
        done: true,
        done_reason: 'stop',
      }));
    });
    await startServer({
      MIRA_STATE_ROOT: stateRoot,
      MIRA_RUNTIME_MODEL_PROVIDER: 'ollama',
      MIRA_OLLAMA_MODEL: 'gemma4:31b',
      MIRA_OLLAMA_BASE_URL: ollamaBaseUrl,
      OPENAI_API_KEY: '',
      MIRA_RUNTIME_OPENAI_API_KEY: '',
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'why did you stop?',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toEqual(expect.objectContaining({
      code: 'empty_ollama_response',
      message: expect.stringContaining('after retry'),
    }));
    expect(payload.error.message).toContain('message_content_length');
    expect(openAiRequests).toHaveLength(2);
  });

  test('journals successful runtime turns under Mira state root and lists them read-only', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-turn-journal-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const turnResponse = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'who are you',
        sessionId: 'app-session-373',
        messageId: 'turn-journal-test-1',
        requestId: 'req-turn-journal-test-1',
      }),
    });
    const turnPayload = await turnResponse.json();
    const listResponse = await fetch(`${baseUrl}/conversation/recent?limit=5`);
    const listPayload = await listResponse.json();
    const cliOutput = execFileSync(process.execPath, [
      path.join(repoRoot, 'mira', 'tools', 'read-runtime-turns.js'),
      '--json',
      '--limit',
      '1',
      '--state-root',
      tempStateRoot,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const cliPayload = JSON.parse(cliOutput);

    expect(turnResponse.status).toBe(200);
    expect(turnPayload.journal).toEqual(expect.objectContaining({
      ok: true,
      written: true,
      record: expect.objectContaining({
        schema: 'mira.runtime_turn_journal.v0',
        outcome: 'ok',
        prompt: 'who are you',
        session_id: 'app-session-373',
        message_id: 'turn-journal-test-1',
        request_id: 'req-turn-journal-test-1',
        external_send: false,
        tools_executed: false,
      }),
    }));
    expect(listResponse.status).toBe(200);
    expect(listPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_turn_journal_list.v0',
      count: 1,
      external_send: false,
      tools_executed: false,
    }));
    expect(listPayload.records[0]).toEqual(expect.objectContaining({
      prompt: 'who are you',
      response: {
        role: 'mira',
        content: turnPayload.response.content,
      },
      voice_lab: expect.objectContaining({
        caseId: 'identity-who-are-you-v0',
      }),
    }));
    expect(cliPayload.records).toHaveLength(1);
    expect(cliPayload.records[0].message_id).toBe('turn-journal-test-1');
  });

  test('journals failed runtime turns with error detail for later quality audit', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-turn-journal-error-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const turnResponse = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '',
        sessionId: 'app-session-373',
        messageId: 'turn-journal-error-test-1',
      }),
    });
    const turnPayload = await turnResponse.json();
    const listResponse = await fetch(`${baseUrl}/conversation/recent?limit=1`);
    const listPayload = await listResponse.json();

    expect(turnResponse.status).toBe(400);
    expect(turnPayload.error).toEqual(expect.objectContaining({
      code: 'empty_turn_text',
    }));
    expect(listResponse.status).toBe(200);
    expect(listPayload.records).toHaveLength(1);
    expect(listPayload.records[0]).toEqual(expect.objectContaining({
      outcome: 'error',
      prompt: '',
      session_id: 'app-session-373',
      message_id: 'turn-journal-error-test-1',
      response: null,
      error: expect.objectContaining({
        code: 'empty_turn_text',
      }),
      external_send: false,
      tools_executed: false,
    }));
  });

  test('can include a manual team plan from a runtime turn without executing it', async () => {
    await startServer();

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Ask Builder for a bridge check.',
        sessionId: 'app-session-373',
        suggestTeamPlanFor: 'builder',
        messageId: 'mira-turn-plan-1',
        requestId: 'req-mira-turn-plan-1',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.suggestedTeamPlan).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_bridge_request_plan.v0',
      manualExecutionRequired: true,
      runtimeExecutes: false,
      target: {
        role: 'builder',
        paneId: '2',
      },
      envelope: expect.objectContaining({
        request_id: 'req-mira-turn-plan-1',
        message_id: 'mira-turn-plan-1',
        session_id: 'app-session-373',
        body: {
          content: payload.response.content,
        },
      }),
    }));
  });
});
