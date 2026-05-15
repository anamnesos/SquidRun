'use strict';

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
    expect(appJs).toContain('Copy text');
    expect(appJs).toContain('Prepare send packet');
    expect(appJs).toContain('Confirm manually');
    expect(appJs).toContain('confirmed manually');
    expect(appJs).toContain('Run pre-send check');
    expect(appJs).toContain('still not sent');
    expect(appJs).toContain('not sent');
    expect(appJs).toContain('workSendConfirmationCount');
    expect(appJs).toContain('workSendCheckCount');
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
        editedDraftText: 'Thanks, I can resend the invoice after I verify the attachment and amount.',
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
      editedDraftText: 'Thanks, I can resend the invoice after I verify the attachment and amount.',
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
      finalReplyText: 'Thanks, I can resend the invoice after I verify the attachment and amount.',
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
      displayTitle: 'Pre-send check',
      notSent: true,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(checkPayload.check.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'recipient present', ok: true }),
      expect.objectContaining({ label: 'channel present', ok: true }),
      expect.objectContaining({ label: 'final text present', ok: true }),
      expect.objectContaining({ label: 'no obvious risky wording', ok: true }),
    ]));
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
      finalReplyText: 'We guarantee this tax advice and need an urgent transfer.',
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
      notSent: true,
      externalSend: false,
      crmMutation: false,
      telegramSend: false,
      runtimeExecutesExternalAction: false,
    }));
    expect(payload.check.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'no obvious risky wording', ok: false }),
    ]));
    expect(payload.check.notes.join(' ')).toContain('should be reviewed before manual send');
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
