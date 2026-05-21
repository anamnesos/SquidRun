const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* global describe, expect, jest, test */

function createElement(tagName = 'div') {
  const element = {
    tagName: String(tagName).toUpperCase(),
    attributes: {},
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    disabled: false,
    checked: false,
    readOnly: false,
    value: '',
    textContent: '',
    className: '',
    type: '',
    rows: 0,
    placeholder: '',
    scrollTop: 0,
    scrollHeight: 0,
    selectedOptions: [{ dataset: {} }],
    listeners: {},
    addEventListener(event, handler) {
      this.listeners[event] = handler;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
      if (nodes.length > 0) {
        this.textContent = '';
      }
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    focus() {},
    remove() {},
    select() {},
  };
  return element;
}

function createRuntimeBootHarness({ allowTurn = false, turnPayload = null } = {}) {
  const elements = {};
  const calls = [];
  const response = (payload, ok = true) => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  });
  const payloads = {
    '/model/providers': {
      ok: true,
      selectedProvider: 'openai_responses',
      choices: [{
        id: 'openai_default',
        label: 'OpenAI API',
        provider: 'openai_responses',
        model: 'gpt-5.5',
        available: true,
        selectable: true,
        runtimeAdapterReady: true,
      }],
    },
    '/model/status': {
      ok: true,
      available: true,
      selectedProvider: 'openai_responses',
      model: 'gpt-5.5',
      nextLocalModelStep: null,
    },
    '/session': {
      service: 'mira-runtime',
      session: {
        stateRootReady: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        liveDataImported: false,
        continuityLoaded: false,
        acceptanceContinuity: {
          loaded: true,
          documentCount: 3,
        },
        normalizedCore: {
          loaded: true,
          documentCount: 3,
        },
        bridge: {
          autoSend: false,
          runtimeInvokesSendCli: false,
          telegramRouteControl: false,
        },
      },
    },
    '/capabilities': {
      service: 'mira-runtime',
      capabilities: [
        { id: 'health', status: 'available' },
        { id: 'capabilities', status: 'available' },
        { id: 'session', status: 'planned' },
        { id: 'telegram_route', status: 'blocked' },
      ],
    },
    '/squidrun/context': {
      ok: true,
      protocol: 'mira.squidrun_context.v0',
      project: {
        name: 'squidrun',
        workspace: 'D:/projects/squidrun',
        squidrunRoot: 'D:/projects/squidrun',
        sessionId: 'app-session-377',
      },
      lane: {
        loaded: true,
        status: 'active',
        sourceRef: 'architect#253',
        targetRole: 'builder',
        objective: 'Build Mission Control from actual local SquidRun evidence.',
        nextAction: 'Implement the Mission Control answer and dry-run coordination preview.',
      },
      ownedWork: {
        loaded: true,
        active: [],
        pendingCount: 2,
      },
      git: {
        loaded: true,
        branch: 'main',
        dirtyCount: 3,
        statusPreview: [
          'M mira/ui/app.js',
          'M mira/ui/index.html',
          'A mira/runtime/src/squidrun-context.ts',
        ],
      },
      dirtyWork: {
        loaded: true,
        summary: '3 changed file(s): mira/ui/app.js, mira/ui/index.html, mira/runtime/src/squidrun-context.ts.',
        files: [
          'mira/ui/app.js',
          'mira/ui/index.html',
          'mira/runtime/src/squidrun-context.ts',
        ],
      },
      systemMap: {
        loaded: true,
        relativePath: 'docs/mira-system-map.md',
        truth: 'New Mira is a prototype until Mission Control proves product value.',
        nextGate: 'Build Mission Control v0.',
      },
      roadmap: {
        loaded: true,
        relativePath: 'docs/mira-north-star-roadmap.md',
        hardTruth: 'Current New Mira is not holy-shit amazing.',
        firstDemo: 'Name: Mira Mission Control v0.',
        stopPivot: 'Stop or pivot if Mission Control cannot answer from local evidence.',
      },
      recentComms: {
        loaded: true,
        latestBuilderInstruction: {
          sourceRef: 'architect#253',
          excerpt: 'Build the smallest judgment/conversation layer on top of local evidence.',
        },
        oracleBenchmark: {
          sourceRef: 'oracle#104',
          excerpt: 'Current New Mira is not impressive yet; Mission Control must prove command-layer value.',
        },
      },
      missionControl: {
        question: 'what is happening here, and what happens next?',
        foundationVsProduct: 'SquidRun context is foundation. The product test is whether Mira can operate as Mission Control for James\'s AI team.',
        answer: [
          'Project/lane: squidrun / architect#253. Build Mission Control from actual local SquidRun evidence.',
          'Dirty work: 3 changed file(s): mira/ui/app.js, mira/ui/index.html, mira/runtime/src/squidrun-context.ts.',
          'Benchmark gate: oracle#104 says current New Mira is not impressive yet; the demo must prove command-layer usefulness.',
          'Foundation vs product: SquidRun context is foundation. The product test is whether Mira can operate as Mission Control for James\'s AI team.',
          'Next team move: Builder implements Mission Control v0; Oracle reviews it against the benchmark before commit.',
          'JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.',
        ].join('\n'),
        nextTeamMove: 'Builder implements Mission Control v0; Oracle reviews it against the benchmark before commit.',
        jamesAction: 'NONE',
        jamesActionReason: 'Local dry-run Mission Control work; no account setup needed.',
        coordinationDrafts: [
          {
            target: 'builder',
            purpose: 'implementation',
            message: 'Build Mission Control v0 from local evidence.',
          },
          {
            target: 'oracle',
            purpose: 'benchmark review',
            message: 'Challenge Mission Control v0 against the external-agent benchmark.',
          },
        ],
        internalRoutePreview: {
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
              body: {
                content: 'Challenge Mission Control v0 against the external-agent benchmark.',
              },
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
        },
        evidence: [
          '.squidrun/link.json',
          'git status --short',
          'docs/mira-north-star-roadmap.md',
        ],
      },
      summary: {
        headline: 'squidrun: Mission Control local evidence loaded',
        happening: 'Working in squidrun on architect#253: Build Mission Control from actual local SquidRun evidence.',
        nextStep: 'Builder implements Mission Control v0; Oracle reviews it against the benchmark before commit.',
        jamesAction: 'NONE',
        jamesActionReason: 'Local dry-run Mission Control work; no account setup needed.',
      },
      reads: {
        link: true,
        currentLane: true,
        ownedWorkQueue: true,
        gitStatus: true,
        systemMap: true,
        roadmap: true,
        recentComms: true,
      },
    },
    '/voice/corrections': {
      ok: true,
      pending_count: 0,
    },
    '/work/drafts': {
      ok: true,
      draftCount: 0,
      drafts: [],
    },
    '/work/tasks': {
      ok: true,
      taskCount: 0,
      pendingCount: 0,
      reviewedCount: 0,
      tasks: [],
    },
    '/work/ready': {
      ok: true,
      readyCount: 0,
      ready: [],
    },
    '/work/send-packets': {
      ok: true,
      packetCount: 0,
      packets: [],
    },
    '/work/send-confirmations': {
      ok: true,
      confirmationCount: 0,
      confirmations: [],
    },
    '/work/send-checks': {
      ok: true,
      checkCount: 0,
      checks: [],
    },
    '/mission-control/route-previews': {
      ok: true,
      previewCount: 0,
      previews: [],
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
    },
    '/mission-control/internal-route-requests': {
      ok: true,
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
    },
    '/mission-control/owned-work-continuations': {
      ok: true,
      continuationCount: 0,
      continuations: [],
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
    },
    '/mission-control/follow-through-recommendations': {
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
    },
    '/mission-control/internal-delivery-previews': {
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
    },
    '/mission-control/dispatch-readiness': {
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
    },
    '/mission-control/internal-send-dry-runs': {
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
    },
    '/mission-control/internal-send-activation-designs': {
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
    },
    '/mission-control/internal-send-activation-requests': {
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
    },
    '/mission-control/internal-send-activation-decision-audits': {
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
    },
    '/mission-control/internal-send-activation-implementation-readiness': {
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
    },
    '/autonomy/status': {
      ok: true,
      queueCount: 0,
      queue: [],
      followThroughCount: 0,
      followThrough: [],
      loop: {
        status: 'disabled',
      },
      brief: {
        available: false,
      },
    },
    '/conversation/memory': {
      ok: true,
      loaded: true,
      summary: {
        summary: 'Submitted turn recorded locally.',
        topics: ['local runtime turn'],
        open_loops: [],
        quality_notes: [],
        source_record_count: 1,
      },
    },
  };
  const fetchImpl = jest.fn(async (url, options = {}) => {
    const pathname = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    calls.push({ url: pathname, method, body });
    if (pathname === '/turn' && method === 'POST' && allowTurn) {
      const defaultTurnPayload = {
        ok: true,
        protocol: 'mira.runtime_turn.v0',
        runtimeExecutes: false,
        modelInvoked: false,
        telegramRouteControl: false,
        uiSurfaceControl: false,
        model: {
          requested: body?.useModel === true,
          provider: null,
          model: null,
          responseId: null,
          toolsEnabled: false,
          sendsEnabled: false,
          store: false,
        },
        input: {
          text: body?.text || '',
          sessionId: body?.sessionId || null,
        },
        state: {
          stateRootReady: true,
          continuityLoaded: false,
          liveDataImported: false,
          acceptanceContinuityLoaded: true,
          acceptanceDocumentCount: 3,
          normalizedCoreLoaded: true,
          normalizedCoreDocumentCount: 3,
        },
        loadedCoreSummary: {
          available: true,
          metadataOnly: true,
          liveContinuityExcluded: true,
        },
        operatorContext: {
          loaded: true,
          operatingLanes: ['local workbench'],
        },
        personaCore: {
          loaded: true,
          name: 'Mira',
          traits: ['present', 'direct'],
          style: ['plain'],
        },
        recentTurns: [],
        recentMemory: {
          loaded: true,
          summary: 'Submitted turn recorded locally.',
          topics: ['local runtime turn'],
          openLoops: [],
          qualityNotes: [],
          sourceRecordCount: 1,
        },
        response: {
          role: 'mira',
          content: 'Mira. Deterministic local turn.',
        },
        visibleReply: {
          role: 'mira',
          content: 'Mira. Deterministic local turn.',
          held: false,
        },
        visibleReplyStatus: {
          checked: true,
          held: false,
          reason: null,
          visibleContentReplaced: false,
          rejectedTextVisible: false,
          violationIdsVisible: false,
          diagnosticsVisible: false,
        },
        voiceLab: null,
        suggestedTeamPlan: null,
        journal: {
          ok: true,
          written: true,
          record: {
            external_send: false,
            tools_executed: false,
          },
        },
      };
      return response(typeof turnPayload === 'function' ? turnPayload(body, defaultTurnPayload) : (turnPayload || defaultTurnPayload));
    }
    if (pathname === '/mission-control/route-previews' && method === 'POST') {
      const record = {
        protocol: 'mira.mission_control_route_preview.v0',
        id: 'mission-route-preview-test',
        actionToken: 'mission-route-test',
        status: 'pending_internal_review',
        createdAt: '2026-05-21T00:00:00.000Z',
        source: body?.source || 'runtime-ui',
        targetRole: body?.preview?.selectedDraftTarget || 'oracle',
        targetPaneId: body?.preview?.plan?.target?.paneId || '3',
        purpose: body?.preview?.selectedDraftPurpose || 'benchmark review',
        content: body?.preview?.plan?.envelope?.body?.content || '',
        contentPreview: body?.preview?.plan?.envelope?.body?.content || '',
        missionAnswerPreview: body?.missionAnswer || '',
        evidence: body?.preview?.plan?.envelope?.evidence || [],
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
      };
      payloads['/mission-control/route-previews'] = {
        ...payloads['/mission-control/route-previews'],
        previewCount: 1,
        previews: [record],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_route_preview_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/route-previews/mission-route-preview-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/route-previews/mission-route-preview-test.json',
        record,
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
      });
    }
    if (pathname === '/mission-control/internal-route-requests' && method === 'POST') {
      const preview = payloads['/mission-control/route-previews'].previews
        .find((candidate) => candidate.actionToken === body?.previewToken);
      if (!preview) {
        return response({ ok: false, error: { message: 'Mission Control route preview was not found.' } }, false);
      }
      const request = {
        protocol: 'mira.mission_control_internal_route_request.v0',
        id: 'mission-route-request-test',
        actionToken: 'mission-request-test',
        status: 'pending_internal_review',
        createdAt: '2026-05-21T00:00:01.000Z',
        sourcePreviewId: preview.id,
        sourcePreviewToken: preview.actionToken,
        targetRole: preview.targetRole,
        targetPaneId: preview.targetPaneId,
        purpose: preview.purpose,
        content: preview.content,
        contentPreview: preview.contentPreview,
        missionAnswerPreview: preview.missionAnswerPreview,
        evidence: preview.evidence,
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
      payloads['/mission-control/internal-route-requests'] = {
        ...payloads['/mission-control/internal-route-requests'],
        requestCount: 1,
        requests: [request],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_internal_route_request_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/internal-route-requests/mission-route-request-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/internal-route-requests/mission-route-request-test.json',
        request,
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
      });
    }
    if (pathname === '/mission-control/owned-work-continuations' && method === 'POST') {
      const request = payloads['/mission-control/internal-route-requests'].requests
        .find((candidate) => candidate.actionToken === body?.requestToken);
      if (!request) {
        return response({ ok: false, error: { message: 'Mission Control route request was not found.' } }, false);
      }
      const continuation = {
        protocol: 'mira.mission_control_owned_work_continuation.v0',
        id: 'mission-owned-work-continuation-test',
        actionToken: 'mission-continuation-test',
        status: body?.decision === 'reject' ? 'rejected' : (body?.decision === 'edit' ? 'edited_for_internal_review' : 'approved_for_internal_review'),
        decision: body?.decision || 'approve',
        createdAt: '2026-05-21T00:00:02.000Z',
        sourceRequestId: request.id,
        sourceRequestToken: request.actionToken,
        sourcePreviewId: request.sourcePreviewId,
        targetRole: request.targetRole,
        targetPaneId: request.targetPaneId,
        purpose: request.purpose,
        content: body?.decision === 'edit' ? body?.editedContent : request.content,
        contentPreview: body?.decision === 'edit' ? body?.editedContent : request.contentPreview,
        editedContent: body?.decision === 'edit' ? body?.editedContent : null,
        note: body?.note || null,
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
      payloads['/mission-control/owned-work-continuations'] = {
        ...payloads['/mission-control/owned-work-continuations'],
        continuationCount: 1,
        continuations: [continuation],
      };
      const recommendation = {
        protocol: 'mira.mission_control_follow_through_recommendation.v0',
        id: 'mission-follow-through-test',
        actionToken: 'mission-follow-through-test',
        status: continuation.decision === 'reject' ? 'not_recommended' : 'selected_for_internal_review',
        selected: continuation.decision !== 'reject',
        createdAt: continuation.createdAt,
        sourceContinuationId: continuation.id,
        sourceContinuationToken: continuation.actionToken,
        sourceContinuationDecision: continuation.decision,
        sourceContinuationStatus: continuation.status,
        sourceRequestId: continuation.sourceRequestId,
        sourceRequestToken: continuation.sourceRequestToken,
        sourcePreviewId: continuation.sourcePreviewId,
        targetRole: continuation.targetRole,
        targetPaneId: continuation.targetPaneId,
        purpose: continuation.purpose,
        nextTeamMove: `Ask ${continuation.targetRole} to review the ${continuation.decision} ${continuation.purpose} continuation: ${continuation.contentPreview}`,
        contentPreview: continuation.contentPreview,
        note: continuation.note,
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
      };
      payloads['/mission-control/follow-through-recommendations'] = {
        ...payloads['/mission-control/follow-through-recommendations'],
        recommendationCount: 1,
        selectedRecommendation: recommendation.selected ? recommendation : null,
        recommendations: [recommendation],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_owned_work_continuation_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/owned-work-continuations/mission-owned-work-continuation-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/owned-work-continuations/mission-owned-work-continuation-test.json',
        continuation,
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
      });
    }
    if (pathname === '/mission-control/internal-delivery-previews' && method === 'POST') {
      const recommendation = payloads['/mission-control/follow-through-recommendations'].recommendations
        .find((candidate) => candidate.actionToken === body?.recommendationToken && candidate.selected === true);
      if (!recommendation) {
        return response({ ok: false, error: { message: 'Mission Control follow-through recommendation was not selected.' } }, false);
      }
      const preview = {
        protocol: 'mira.mission_control_internal_delivery_preview.v0',
        id: 'mission-delivery-preview-test',
        actionToken: 'mission-delivery-preview-test',
        status: 'reviewed_preview_only',
        createdAt: '2026-05-21T00:00:03.000Z',
        sourceRecommendationId: recommendation.id,
        sourceRecommendationToken: recommendation.actionToken,
        sourceContinuationId: recommendation.sourceContinuationId,
        sourceContinuationToken: recommendation.sourceContinuationToken,
        sourceRequestId: recommendation.sourceRequestId,
        sourceRequestToken: recommendation.sourceRequestToken,
        sourcePreviewId: recommendation.sourcePreviewId,
        targetRole: recommendation.targetRole,
        targetPaneId: recommendation.targetPaneId,
        purpose: recommendation.purpose,
        content: recommendation.contentPreview,
        contentPreview: recommendation.contentPreview,
        nextTeamMove: recommendation.nextTeamMove,
        selectorReason: recommendation.selectorReason,
        deliveryPacket: {
          protocol: 'mira.mission_control_internal_delivery_preview_packet.v0',
          target: {
            system: 'squidrun',
            role: recommendation.targetRole,
            paneId: recommendation.targetPaneId,
          },
          body: {
            content: recommendation.contentPreview,
          },
        },
        reviewDetails: {
          protocol: 'mira.mission_control_internal_delivery_preview_review.v0',
          targetLabel: `${recommendation.targetRole} pane ${recommendation.targetPaneId}`,
          packetSha256: 'packet-sha256-test',
          bodySha256: 'body-sha256-test',
          bodyCharCount: recommendation.contentPreview.length,
          copyText: recommendation.contentPreview,
          copyInstruction: `Manual copy only: paste this body into ${recommendation.targetRole} pane ${recommendation.targetPaneId} after review.`,
          manualCopyRequired: true,
          previewOnly: true,
          noLiveSend: true,
        },
        audit: {
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
      payloads['/mission-control/internal-delivery-previews'] = {
        ...payloads['/mission-control/internal-delivery-previews'],
        previewCount: 1,
        previews: [preview],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_internal_delivery_preview_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/internal-delivery-previews/mission-delivery-preview-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/internal-delivery-previews/mission-delivery-preview-test.json',
        preview,
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
      });
    }
    if (pathname === '/mission-control/dispatch-readiness' && method === 'POST') {
      const preview = payloads['/mission-control/internal-delivery-previews'].previews
        .find((candidate) => candidate.actionToken === body?.deliveryPreviewToken);
      if (!preview) {
        return response({ ok: false, error: { message: 'Mission Control delivery preview was not found.' } }, false);
      }
      const readiness = {
        protocol: 'mira.mission_control_dispatch_readiness.v0',
        id: 'mission-dispatch-readiness-test',
        actionToken: 'mission-dispatch-readiness-test',
        status: 'ready_for_manual_dispatch_review',
        createdAt: '2026-05-21T00:00:04.000Z',
        sourceDeliveryPreviewId: preview.id,
        sourceDeliveryPreviewToken: preview.actionToken,
        sourceRecommendationId: preview.sourceRecommendationId,
        sourceContinuationId: preview.sourceContinuationId,
        sourceRequestId: preview.sourceRequestId,
        sourcePreviewId: preview.sourcePreviewId,
        targetRole: preview.targetRole,
        targetPaneId: preview.targetPaneId,
        targetLabel: preview.reviewDetails.targetLabel,
        purpose: preview.purpose,
        content: preview.content,
        contentPreview: preview.contentPreview,
        packetSha256: preview.reviewDetails.packetSha256,
        bodySha256: preview.reviewDetails.bodySha256,
        copyTextSha256: preview.reviewDetails.bodySha256,
        checksumMatched: true,
        copiedPaneMessage: {
          targetRole: preview.targetRole,
          targetPaneId: preview.targetPaneId,
          body: preview.reviewDetails.copyText,
          bodySha256: preview.reviewDetails.bodySha256,
          bodyCharCount: preview.reviewDetails.copyText.length,
        },
        checklist: [
          { id: 'pane_target_matches', label: `Pane target is ${preview.reviewDetails.targetLabel}`, ok: true },
          { id: 'copied_body_checksum_matches', label: 'Copied pane body checksum matches the saved delivery preview body.', ok: true },
          { id: 'manual_review_required', label: 'Manual pane review is required before dispatch.', ok: true },
          { id: 'no_delivery_path', label: 'Checklist is review-only: no hm-send, Telegram, route flip, provider/model, runtime execution, or external delivery.', ok: true },
        ],
        audit: {
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
      payloads['/mission-control/dispatch-readiness'] = {
        ...payloads['/mission-control/dispatch-readiness'],
        readinessCount: 1,
        readiness: [readiness],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_dispatch_readiness_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/dispatch-readiness/mission-dispatch-readiness-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/dispatch-readiness/mission-dispatch-readiness-test.json',
        readiness,
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
      });
    }
    if (pathname === '/mission-control/internal-send-dry-runs' && method === 'POST') {
      const readiness = payloads['/mission-control/dispatch-readiness'].readiness
        .find((candidate) => candidate.actionToken === body?.dispatchReadinessToken);
      if (!readiness) {
        return response({ ok: false, error: { message: 'Mission Control dispatch-readiness checklist was not found.' } }, false);
      }
      const dryRun = {
        protocol: 'mira.mission_control_internal_send_dry_run.v0',
        id: 'mission-send-dry-run-test',
        actionToken: 'mission-send-dry-run-test',
        status: 'dry_run_ready',
        createdAt: '2026-05-21T00:00:05.000Z',
        sourceDispatchReadinessId: readiness.id,
        sourceDispatchReadinessToken: readiness.actionToken,
        sourceDeliveryPreviewId: readiness.sourceDeliveryPreviewId,
        sourceDeliveryPreviewToken: readiness.sourceDeliveryPreviewToken,
        sourceRecommendationId: readiness.sourceRecommendationId,
        sourceContinuationId: readiness.sourceContinuationId,
        sourceRequestId: readiness.sourceRequestId,
        sourcePreviewId: readiness.sourcePreviewId,
        targetRole: readiness.targetRole,
        targetPaneId: readiness.targetPaneId,
        targetLabel: readiness.targetLabel,
        purpose: readiness.purpose,
        content: readiness.copiedPaneMessage.body,
        contentPreview: readiness.contentPreview,
        bodySha256: readiness.bodySha256,
        packetSha256: readiness.packetSha256,
        adapterDryRun: {
          protocol: 'mira.hm_send_adapter.v0',
          dryRun: true,
          channel: 'hm-send',
          transport: 'ui/scripts/hm-send.js',
          target: {
            system: 'squidrun',
            role: readiness.targetRole,
            pane_id: readiness.targetPaneId,
          },
          body: {
            content: readiness.copiedPaneMessage.body,
          },
        },
        activationGate: {
          protocol: 'mira.mission_control_internal_send_activation_gate.v0',
          required: true,
          requiredReview: 'separate_reviewed_activation',
          realSendAllowed: false,
          liveHmSendExecutionAllowed: false,
        },
        audit: {
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
      payloads['/mission-control/internal-send-dry-runs'] = {
        ...payloads['/mission-control/internal-send-dry-runs'],
        dryRunCount: 1,
        dryRuns: [dryRun],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_internal_send_dry_run_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/internal-send-dry-runs/mission-send-dry-run-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/internal-send-dry-runs/mission-send-dry-run-test.json',
        dryRun,
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
      });
    }
    if (pathname === '/mission-control/internal-send-activation-designs' && method === 'POST') {
      const dryRun = payloads['/mission-control/internal-send-dry-runs'].dryRuns
        .find((candidate) => candidate.actionToken === body?.internalSendDryRunToken);
      if (!dryRun) {
        return response({ ok: false, error: { message: 'Mission Control internal-send dry run was not found.' } }, false);
      }
      const design = {
        protocol: 'mira.mission_control_internal_send_activation_design.v0',
        id: 'mission-send-activation-design-test',
        actionToken: 'mission-send-activation-design-test',
        status: 'activation_design_review_only',
        createdAt: '2026-05-21T00:00:06.000Z',
        sourceInternalSendDryRunId: dryRun.id,
        sourceInternalSendDryRunToken: dryRun.actionToken,
        sourceDispatchReadinessId: dryRun.sourceDispatchReadinessId,
        sourceDispatchReadinessToken: dryRun.sourceDispatchReadinessToken,
        sourceDeliveryPreviewId: dryRun.sourceDeliveryPreviewId,
        sourceDeliveryPreviewToken: dryRun.sourceDeliveryPreviewToken,
        sourceRecommendationId: dryRun.sourceRecommendationId,
        sourceContinuationId: dryRun.sourceContinuationId,
        sourceRequestId: dryRun.sourceRequestId,
        sourcePreviewId: dryRun.sourcePreviewId,
        targetRole: dryRun.targetRole,
        targetPaneId: dryRun.targetPaneId,
        targetLabel: dryRun.targetLabel,
        purpose: dryRun.purpose,
        content: dryRun.content,
        contentPreview: dryRun.contentPreview,
        bodySha256: dryRun.bodySha256,
        adapterPacketSha256: 'adapter-packet-sha256',
        activationDesign: {
          protocol: 'mira.mission_control_internal_send_activation_design_gate.v0',
          designOnly: true,
          activationAllowed: false,
          requiredReview: 'separate_reviewed_activation',
          refusalRollbackAuditRequired: true,
          liveHmSendExecutionAllowed: false,
          realSendAllowed: false,
        },
        refusalRequirements: [
          { id: 'missing_or_bad_token_refuses', label: 'Missing or unknown internal-send dry-run tokens must return 400 without writing.', ok: true },
          { id: 'live_effect_input_refuses', label: 'Any live-effect activation flag must be refused before an activation-design record is written.', ok: true },
          { id: 'command_input_refuses', label: 'Command or args fields must be refused before an activation-design record is written.', ok: true },
          { id: 'separate_review_required', label: 'Real hm-send activation remains blocked until a separate reviewed activation gate exists.', ok: true },
        ],
        rollbackRequirements: [
          { id: 'pre_activation_snapshot_required', label: 'Future activation must snapshot the dry-run token, target, body checksum, and adapter checksum before any execution.', ok: true },
          { id: 'failure_audit_required', label: 'Future activation failure must record a not-sent/failure audit before retry or rollback.', ok: true },
        ],
        auditRequirements: [
          { id: 'durable_activation_audit_required', label: 'Future activation must write a durable audit row with reviewer, checksum, and outcome.', ok: true },
          { id: 'transport_result_audit_required', label: 'Future activation must record the hm-send transport result without changing route ownership.', ok: true },
          { id: 'no_command_storage_required', label: 'This design stores requirements only and no executable command or args.', ok: true },
        ],
        audit: {
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
      payloads['/mission-control/internal-send-activation-designs'] = {
        ...payloads['/mission-control/internal-send-activation-designs'],
        designCount: 1,
        designs: [design],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_internal_send_activation_design_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/internal-send-activation-designs/mission-send-activation-design-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/internal-send-activation-designs/mission-send-activation-design-test.json',
        design,
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
      });
    }
    if (pathname === '/mission-control/internal-send-activation-requests' && method === 'POST') {
      const design = payloads['/mission-control/internal-send-activation-designs'].designs
        .find((candidate) => candidate.actionToken === body?.internalSendActivationDesignToken);
      if (!design) {
        return response({ ok: false, error: { message: 'Mission Control internal-send activation design was not found.' } }, false);
      }
      const request = {
        protocol: 'mira.mission_control_internal_send_activation_request_preview.v0',
        id: 'mission-send-activation-request-test',
        actionToken: 'mission-send-activation-request-test',
        status: 'activation_request_review_only',
        createdAt: '2026-05-21T00:00:07.000Z',
        sourceInternalSendActivationDesignId: design.id,
        sourceInternalSendActivationDesignToken: design.actionToken,
        sourceInternalSendDryRunId: design.sourceInternalSendDryRunId,
        sourceInternalSendDryRunToken: design.sourceInternalSendDryRunToken,
        sourceDispatchReadinessId: design.sourceDispatchReadinessId,
        sourceDispatchReadinessToken: design.sourceDispatchReadinessToken,
        sourceDeliveryPreviewId: design.sourceDeliveryPreviewId,
        sourceDeliveryPreviewToken: design.sourceDeliveryPreviewToken,
        sourceRecommendationId: design.sourceRecommendationId,
        sourceContinuationId: design.sourceContinuationId,
        sourceRequestId: design.sourceRequestId,
        sourcePreviewId: design.sourcePreviewId,
        targetRole: design.targetRole,
        targetPaneId: design.targetPaneId,
        targetLabel: design.targetLabel,
        purpose: design.purpose,
        content: design.content,
        contentPreview: design.contentPreview,
        bodySha256: design.bodySha256,
        adapterPacketSha256: design.adapterPacketSha256,
        reviewer: {
          required: true,
          status: 'pending_review',
          reviewerRole: 'architect_or_oracle',
          note: 'A reviewer must accept the request preview before any separate live activation lane.',
        },
        activationRequest: {
          protocol: 'mira.mission_control_internal_send_activation_request_gate.v0',
          previewOnly: true,
          activationAllowed: false,
          requiredReview: 'separate_reviewed_activation',
          reviewerRequired: true,
          refusalRollbackAuditRequired: true,
          liveHmSendExecutionAllowed: false,
          realSendAllowed: false,
        },
        refusalPolicy: [
          { id: 'activation_design_token_required', label: 'Missing or unknown activation-design tokens must return 400 without writing.', ok: true },
          { id: 'activation_design_checksum_required', label: 'Activation-design body checksum must match before a request preview is written.', ok: true },
          { id: 'separate_activation_required', label: 'This request preview cannot perform live hm-send; real send remains a later reviewed activation gate.', ok: true },
        ],
        rollbackPlan: [
          { id: 'rollback_path_required', label: 'A later activation must define rollback/failure handling before execution is allowed.', ok: true },
          { id: 'activation_design_checksum_required', label: 'The activation design token, body checksum, and adapter checksum must be preserved for rollback review.', ok: true },
        ],
        auditPlan: [
          { id: 'reviewer_required', label: 'A reviewer field is required before any activation request can leave preview mode.', ok: true },
          { id: 'audit_path_required', label: 'A later activation must record reviewer, refusal, rollback, transport outcome, and no-route-flip evidence.', ok: true },
        ],
        audit: {
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
      payloads['/mission-control/internal-send-activation-requests'] = {
        ...payloads['/mission-control/internal-send-activation-requests'],
        requestCount: 1,
        requests: [request],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_internal_send_activation_request_preview_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/internal-send-activation-requests/mission-send-activation-request-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/internal-send-activation-requests/mission-send-activation-request-test.json',
        request,
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
      });
    }
    if (pathname === '/mission-control/internal-send-activation-decision-audits' && method === 'POST') {
      const request = payloads['/mission-control/internal-send-activation-requests'].requests
        .find((candidate) => candidate.actionToken === body?.internalSendActivationRequestToken);
      if (!request) {
        return response({ ok: false, error: { message: 'Mission Control internal-send activation request was not found.' } }, false);
      }
      const audit = {
        protocol: 'mira.mission_control_internal_send_activation_decision_audit.v0',
        id: 'mission-send-activation-audit-test',
        actionToken: 'mission-send-activation-audit-test',
        status: 'activation_decision_audit_review_only',
        createdAt: '2026-05-21T00:00:08.000Z',
        sourceInternalSendActivationRequestId: request.id,
        sourceInternalSendActivationRequestToken: request.actionToken,
        sourceInternalSendActivationDesignId: request.sourceInternalSendActivationDesignId,
        sourceInternalSendActivationDesignToken: request.sourceInternalSendActivationDesignToken,
        sourceInternalSendDryRunId: request.sourceInternalSendDryRunId,
        sourceInternalSendDryRunToken: request.sourceInternalSendDryRunToken,
        sourceDispatchReadinessId: request.sourceDispatchReadinessId,
        sourceDispatchReadinessToken: request.sourceDispatchReadinessToken,
        sourceDeliveryPreviewId: request.sourceDeliveryPreviewId,
        sourceDeliveryPreviewToken: request.sourceDeliveryPreviewToken,
        sourceRecommendationId: request.sourceRecommendationId,
        sourceContinuationId: request.sourceContinuationId,
        sourceRequestId: request.sourceRequestId,
        sourcePreviewId: request.sourcePreviewId,
        targetRole: request.targetRole,
        targetPaneId: request.targetPaneId,
        targetLabel: request.targetLabel,
        purpose: request.purpose,
        content: request.content,
        contentPreview: request.contentPreview,
        bodySha256: request.bodySha256,
        adapterPacketSha256: request.adapterPacketSha256,
        reviewer: {
          required: true,
          status: 'pending_review',
          reviewerRole: 'architect_or_oracle',
        },
        decision: {
          protocol: 'mira.mission_control_internal_send_activation_decision.v0',
          reviewOnly: true,
          decision: 'refuse_live_activation_until_separate_gate',
          activationAllowed: false,
          liveHmSendExecutionAllowed: false,
          realSendAllowed: false,
          separateActivationRequired: true,
        },
        refusal: {
          status: 'refused_for_live_execution',
          reason: 'No live hm-send execution is allowed from this review-only audit artifact.',
          liveEffectBlocked: true,
        },
        rollbackAudit: {
          status: 'rollback_audit_previewed',
          requiresPreActivationSnapshot: true,
          requiresFailureAudit: true,
          requiresTransportOutcomeAudit: true,
        },
        auditRequirements: [
          { id: 'activation_request_token_required', label: 'Missing or unknown activation-request tokens must return 400 without writing.', ok: true },
          { id: 'activation_request_checksum_required', label: 'Activation-request body checksum must match before a decision audit is written.', ok: true },
          { id: 'review_decision_recorded', label: 'The review-only decision is recorded without allowing activation.', ok: true },
          { id: 'refusal_recorded', label: 'Live execution refusal is recorded before any future activation gate.', ok: true },
          { id: 'rollback_audit_recorded', label: 'Rollback and failure-audit requirements are recorded before any future activation gate.', ok: true },
          { id: 'separate_activation_required', label: 'Real hm-send activation remains a later separately reviewed gate.', ok: true },
        ],
        audit: {
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
      payloads['/mission-control/internal-send-activation-decision-audits'] = {
        ...payloads['/mission-control/internal-send-activation-decision-audits'],
        auditCount: 1,
        audits: [audit],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_internal_send_activation_decision_audit_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/internal-send-activation-decision-audits/mission-send-activation-audit-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/internal-send-activation-decision-audits/mission-send-activation-audit-test.json',
        audit,
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
      });
    }
    if (pathname === '/mission-control/internal-send-activation-implementation-readiness' && method === 'POST') {
      const audit = payloads['/mission-control/internal-send-activation-decision-audits'].audits
        .find((candidate) => candidate.actionToken === body?.internalSendActivationDecisionAuditToken);
      if (!audit) {
        return response({ ok: false, error: { message: 'Mission Control internal-send activation decision audit was not found.' } }, false);
      }
      const readiness = {
        protocol: 'mira.mission_control_internal_send_activation_implementation_readiness.v0',
        id: 'mission-send-activation-implementation-test',
        actionToken: 'mission-send-activation-ready-test',
        status: 'activation_implementation_readiness_review_only',
        createdAt: '2026-05-21T00:00:09.000Z',
        sourceInternalSendActivationDecisionAuditId: audit.id,
        sourceInternalSendActivationDecisionAuditToken: audit.actionToken,
        sourceInternalSendActivationRequestId: audit.sourceInternalSendActivationRequestId,
        sourceInternalSendActivationRequestToken: audit.sourceInternalSendActivationRequestToken,
        sourceInternalSendActivationDesignId: audit.sourceInternalSendActivationDesignId,
        sourceInternalSendActivationDesignToken: audit.sourceInternalSendActivationDesignToken,
        sourceInternalSendDryRunId: audit.sourceInternalSendDryRunId,
        sourceInternalSendDryRunToken: audit.sourceInternalSendDryRunToken,
        sourceDispatchReadinessId: audit.sourceDispatchReadinessId,
        sourceDispatchReadinessToken: audit.sourceDispatchReadinessToken,
        sourceDeliveryPreviewId: audit.sourceDeliveryPreviewId,
        sourceDeliveryPreviewToken: audit.sourceDeliveryPreviewToken,
        sourceRecommendationId: audit.sourceRecommendationId,
        sourceContinuationId: audit.sourceContinuationId,
        sourceRequestId: audit.sourceRequestId,
        sourcePreviewId: audit.sourcePreviewId,
        targetRole: audit.targetRole,
        targetPaneId: audit.targetPaneId,
        targetLabel: audit.targetLabel,
        purpose: audit.purpose,
        content: audit.content,
        contentPreview: audit.contentPreview,
        bodySha256: audit.bodySha256,
        adapterPacketSha256: audit.adapterPacketSha256,
        implementationGate: {
          protocol: 'mira.mission_control_internal_send_activation_implementation_gate.v0',
          readinessOnly: true,
          disabledByDefault: true,
          implementationEnabled: false,
          activationAllowed: false,
          liveHmSendExecutionAllowed: false,
          realSendAllowed: false,
          separateActivationRequired: true,
        },
        refusal: {
          status: 'live_activation_still_refused',
          sourceDecision: 'refuse_live_activation_until_separate_gate',
          reason: 'Implementation readiness is review-only and remains disabled until a separate activation implementation gate exists.',
        },
        rollback: {
          status: 'rollback_requirements_ready',
          preActivationSnapshotRequired: true,
          failureAuditRequired: true,
          transportOutcomeAuditRequired: true,
        },
        auditRequirements: [
          { id: 'decision_audit_token_required', label: 'Missing or unknown decision-audit tokens must return 400 without writing.', ok: true },
          { id: 'decision_audit_checksum_required', label: 'Decision-audit body checksum must match before implementation readiness is written.', ok: true },
          { id: 'decision_refusal_required', label: 'Source decision must refuse live activation before implementation readiness can be recorded.', ok: true },
          { id: 'disabled_by_default_required', label: 'Activation implementation stays disabled by default.', ok: true },
          { id: 'rollback_audit_required', label: 'Rollback and failure-audit requirements remain required before any future activation.', ok: true },
          { id: 'separate_activation_required', label: 'Real hm-send activation remains its own later reviewed gate.', ok: true },
        ],
        audit: {
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
      payloads['/mission-control/internal-send-activation-implementation-readiness'] = {
        ...payloads['/mission-control/internal-send-activation-implementation-readiness'],
        readinessCount: 1,
        readiness: [readiness],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_internal_send_activation_implementation_readiness_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/internal-send-activation-implementation-readiness/mission-send-activation-implementation-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/internal-send-activation-implementation-readiness/mission-send-activation-implementation-test.json',
        readiness,
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
      });
    }
    if (!Object.prototype.hasOwnProperty.call(payloads, pathname)) {
      return response({ ok: false, error: { message: `unexpected endpoint: ${pathname}` } }, false);
    }
    return response(payloads[pathname]);
  });
  const document = {
    body: createElement('body'),
    createElement,
    execCommand: jest.fn(),
    getElementById(id) {
      if (!elements[id]) elements[id] = createElement();
      return elements[id];
    },
  };

  elements.useModel = document.getElementById('useModel');
  elements.useModel.checked = true;
  elements.saveRoutePreviewButton = document.getElementById('saveRoutePreviewButton');
  elements.saveRoutePreviewButton.textContent = 'Save preview for review';

  return {
    calls,
    context: {
      console,
      document,
      fetch: fetchImpl,
      navigator: {
        clipboard: {
          writeText: jest.fn(),
        },
      },
      window: {
        addEventListener: jest.fn(),
        matchMedia: jest.fn(() => ({
          matches: false,
        })),
      },
    },
    elements,
    fetchImpl,
  };
}

async function waitForBoot(calls) {
  for (let index = 0; index < 30; index += 1) {
    if (calls.some((call) => call.url === '/autonomy/status')) {
      await new Promise((resolve) => setImmediate(resolve));
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`boot did not complete; calls=${JSON.stringify(calls)}`);
}

function collectMissionControlText(elements) {
  const draftText = elements.coordinationDraftList.children
    .flatMap((item) => item.children.map((child) => child.textContent))
    .join('\n');
  return [
    elements.missionAnswer.textContent,
    draftText,
    elements.routePreviewSummary.textContent,
    elements.foundationSummary.textContent,
    elements.laneSummary.textContent,
    elements.nextStepSummary.textContent,
    elements.gitSummary.textContent,
    elements.mapTruthSummary.textContent,
    elements.jamesNeedSummary.textContent,
  ].join('\n');
}

describe('Mira runtime UI boot', () => {
  test('hydrates the workbench with read-only GET calls and does not call turn endpoints', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    expect(harness.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/model/providers', method: 'GET' }),
      expect.objectContaining({ url: '/model/status', method: 'GET' }),
      expect.objectContaining({ url: '/session', method: 'GET' }),
      expect.objectContaining({ url: '/capabilities', method: 'GET' }),
      expect.objectContaining({ url: '/squidrun/context', method: 'GET' }),
      expect.objectContaining({ url: '/voice/corrections', method: 'GET' }),
      expect.objectContaining({ url: '/work/drafts', method: 'GET' }),
      expect.objectContaining({ url: '/work/tasks', method: 'GET' }),
      expect.objectContaining({ url: '/work/ready', method: 'GET' }),
      expect.objectContaining({ url: '/work/send-packets', method: 'GET' }),
      expect.objectContaining({ url: '/work/send-confirmations', method: 'GET' }),
      expect.objectContaining({ url: '/work/send-checks', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/route-previews', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/internal-route-requests', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/owned-work-continuations', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/follow-through-recommendations', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/internal-delivery-previews', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/dispatch-readiness', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/internal-send-dry-runs', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/internal-send-activation-designs', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/internal-send-activation-requests', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/internal-send-activation-decision-audits', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/internal-send-activation-implementation-readiness', method: 'GET' }),
      expect.objectContaining({ url: '/autonomy/status', method: 'GET' }),
    ]));
    expect(harness.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.calls.some((call) => call.url === '/conversation/memory')).toBe(false);
    expect(harness.elements.modelSummary.textContent).toContain('OpenAI ready: gpt-5.5');
    expect(harness.elements.operatorSummary.textContent).toBe('Local state root ready.');
    expect(harness.elements.coreSummary.textContent).toBe('3 acceptance docs and 3 core records available.');
    expect(harness.elements.projectSummary.textContent).toBe('squidrun · architect#253');
    expect(harness.elements.missionAnswer.textContent).toContain('Project/lane: squidrun / architect#253.');
    expect(harness.elements.missionAnswer.textContent).toContain('Benchmark gate: oracle#104');
    expect(harness.elements.missionAnswer.textContent).toContain('Foundation vs product: SquidRun context is foundation.');
    expect(harness.elements.coordinationDraftList.children).toHaveLength(2);
    expect(harness.elements.coordinationDraftList.children[0].children[0].textContent).toBe('builder · implementation');
    expect(harness.elements.routePreviewSummary.textContent).toBe('Route preview: oracle · benchmark review · reviewed preview only · manual execution required · no runtime execution · no external send · no route flip · no provider.');
    expect(harness.elements.saveRoutePreviewButton.textContent).toBe('Save preview for review');
    expect(harness.elements.routePreviewHistoryList.textContent).toBe('no saved route previews yet');
    expect(harness.elements.routeRequestList.textContent).toBe('no route review items yet');
    expect(harness.elements.routeContinuationPanel.textContent).toBe('choose a route review item');
    expect(harness.elements.routeContinuationList.textContent).toBe('no owned-work continuations yet');
    expect(harness.elements.routeFollowThroughList.textContent).toBe('no follow-through recommendation yet');
    expect(harness.elements.routeDeliveryPreviewList.textContent).toBe('no internal delivery previews yet');
    expect(harness.elements.routeDispatchReadinessList.textContent).toBe('no dispatch-readiness checklists yet');
    expect(harness.elements.routeInternalSendDryRunList.textContent).toBe('no internal-send dry runs yet');
    expect(harness.elements.routeInternalSendActivationDesignList.textContent).toBe('no activation designs yet');
    expect(harness.elements.routeInternalSendActivationRequestList.textContent).toBe('no activation requests yet');
    expect(harness.elements.routeInternalSendActivationAuditList.textContent).toBe('no activation decision audits yet');
    expect(harness.elements.routeInternalSendActivationReadinessList.textContent).toBe('no activation implementation readiness yet');
    expect(harness.elements.foundationSummary.textContent).toBe('Foundation vs product: SquidRun context is foundation. The product test is whether Mira can operate as Mission Control for James\'s AI team.');
    expect(harness.elements.laneSummary.textContent).toBe('What is happening: Working in squidrun on architect#253: Build Mission Control from actual local SquidRun evidence.');
    expect(harness.elements.nextStepSummary.textContent).toBe('Next here: Builder implements Mission Control v0; Oracle reviews it against the benchmark before commit.');
    expect(harness.elements.gitSummary.textContent).toBe('Git: 3 changed file(s): mira/ui/app.js, mira/ui/index.html, mira/runtime/src/squidrun-context.ts.');
    expect(harness.elements.mapTruthSummary.textContent).toBe('Map truth: Current New Mira is not holy-shit amazing.');
    expect(harness.elements.jamesNeedSummary.textContent).toBe('James needed: no · Local dry-run Mission Control work; no account setup needed.');
    expect((collectMissionControlText(harness.elements).match(/JAMES ACTION:/g) || [])).toHaveLength(1);
    expect(harness.elements.lastTurn.textContent).toBe('no turn yet');
    expect(harness.elements.workSummary.textContent).toContain('0 drafts / 0 pending');
    expect(harness.elements.workSummary.textContent).toContain('0 route previews');
    expect(harness.elements.workSummary.textContent).toContain('0 route review items');
    expect(harness.elements.workSummary.textContent).toContain('0 continuations');
    expect(harness.elements.workSummary.textContent).toContain('0 team recommendations');
    expect(harness.elements.workSummary.textContent).toContain('0 delivery previews');
    expect(harness.elements.workSummary.textContent).toContain('0 dispatch checklists');
    expect(harness.elements.workSummary.textContent).toContain('0 send dry runs');
    expect(harness.elements.workSummary.textContent).toContain('0 activation designs');
    expect(harness.elements.workSummary.textContent).toContain('0 activation requests');
    expect(harness.elements.workSummary.textContent).toContain('0 activation audits');
    expect(harness.elements.workSummary.textContent).toContain('0 activation readiness');
    expect(harness.elements.workSummary.textContent).toContain('2 queued');
  });

  test('saves the Mission Control route preview and promotes it to continuation only after explicit user actions', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    expect(harness.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(harness.calls.filter((call) => call.url === '/mission-control/route-previews')).toEqual([
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-route-requests')).toEqual([
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/owned-work-continuations')).toEqual([
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/follow-through-recommendations')).toEqual([
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-delivery-previews')).toEqual([
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/dispatch-readiness')).toEqual([
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-send-dry-runs')).toEqual([
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-designs')).toEqual([
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-requests')).toEqual([
      expect.objectContaining({ method: 'GET' }),
    ]);

    await harness.elements.saveRoutePreviewButton.listeners.click();

    const routePreviewCalls = harness.calls.filter((call) => call.url === '/mission-control/route-previews');
    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(routePreviewCalls).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          source: 'runtime-ui',
          missionAnswer: expect.stringContaining('Project/lane: squidrun / architect#253.'),
          preview: expect.objectContaining({
            status: 'reviewed_preview_only',
            selectedDraftTarget: 'oracle',
            selectedDraftPurpose: 'benchmark review',
            plan: expect.objectContaining({
              manualExecutionRequired: true,
              runtimeExecutes: false,
            }),
            audit: expect.objectContaining({
              reviewStatus: 'preview_ready',
              sendPerformed: false,
              runtimeExecutes: false,
              externalSend: false,
              routeFlip: false,
              providerInvoked: false,
            }),
          }),
        }),
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-route-requests')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/owned-work-continuations')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/follow-through-recommendations')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-delivery-previews')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/dispatch-readiness')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-send-dry-runs')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-designs')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-requests')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.calls.some((call) => call.url === '/bridge/manual-plan')).toBe(false);
    expect(harness.fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('hm-send'), expect.anything());
    expect(harness.elements.routePreviewHistoryList.children).toHaveLength(1);
    const historyText = harness.elements.routePreviewHistoryList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(historyText).toContain('oracle · benchmark review');
    expect(historyText).toContain('pending internal review · manual execution required · not sent');
    expect(historyText).toContain('no runtime execution, external send, route flip, provider, account or token access, or live hm-send');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Route preview saved for internal review. Nothing was sent or executed.');
    expect(harness.elements.saveRoutePreviewButton.disabled).toBe(false);
    expect(harness.elements.saveRoutePreviewButton.textContent).toBe('Save preview for review');

    const promoteButton = harness.elements.routePreviewHistoryList.children[0].children
      .find((child) => child.tagName === 'BUTTON');
    expect(promoteButton.textContent).toBe('Make review item');
    await promoteButton.listeners.click();

    const routeRequestCalls = harness.calls.filter((call) => call.url === '/mission-control/internal-route-requests');
    const allPostCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(allPostCalls).toHaveLength(2);
    expect(routeRequestCalls).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({
        method: 'POST',
        body: {
          previewToken: 'mission-route-test',
        },
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.some((call) => call.url === '/bridge/manual-plan')).toBe(false);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.routeRequestList.children).toHaveLength(1);
    const requestText = harness.elements.routeRequestList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(requestText).toContain('oracle · benchmark review review item');
    expect(requestText).toContain('pending internal review · manual execution required · not sent');
    expect(requestText).toContain('no command stored, runtime execution, external send, route flip, provider, account or token access, or live hm-send');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Route review item saved locally. Nothing was sent or executed.');

    const reviewButton = harness.elements.routeRequestList.children[0].children
      .find((child) => child.tagName === 'BUTTON');
    expect(reviewButton.textContent).toBe('review continuation');
    reviewButton.listeners.click();
    expect(harness.elements.routeContinuationPanel.children[0].textContent).toBe('oracle · benchmark review continuation');
    const editor = harness.elements.routeContinuationPanel.children
      .find((child) => child.tagName === 'TEXTAREA');
    const note = harness.elements.routeContinuationPanel.children
      .find((child) => child.tagName === 'INPUT');
    editor.value = 'Edited internal continuation for Oracle review.';
    note.value = 'Keep this as Mission Control owned-work metadata only.';
    const actions = harness.elements.routeContinuationPanel.children
      .find((child) => child.className === 'review-actions');
    const saveEditButton = actions.children.find((child) => child.textContent === 'Save edit');
    await saveEditButton.listeners.click();

    const routeContinuationCalls = harness.calls.filter((call) => call.url === '/mission-control/owned-work-continuations');
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(3);
    expect(routeContinuationCalls).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({
        method: 'POST',
        body: {
          requestToken: 'mission-request-test',
          decision: 'edit',
          editedContent: 'Edited internal continuation for Oracle review.',
          note: 'Keep this as Mission Control owned-work metadata only.',
        },
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    const followThroughCalls = harness.calls.filter((call) => call.url === '/mission-control/follow-through-recommendations');
    expect(followThroughCalls).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(followThroughCalls.every((call) => call.method === 'GET')).toBe(true);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-delivery-previews')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/dispatch-readiness')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-send-dry-runs')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-designs')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-requests')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.some((call) => call.url === '/bridge/manual-plan')).toBe(false);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.routeContinuationList.children).toHaveLength(1);
    const continuationText = harness.elements.routeContinuationList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(continuationText).toContain('oracle · edit continuation');
    expect(continuationText).toContain('edited for internal review · manual execution required · not sent');
    expect(continuationText).toContain('Edited internal continuation for Oracle review.');
    expect(continuationText).toContain('no command stored, runtime execution, external send, route flip, provider, account or token access, or live hm-send');
    expect(harness.elements.routeFollowThroughList.children).toHaveLength(1);
    const followThroughText = harness.elements.routeFollowThroughList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(followThroughText).toContain('Selected next internal move: oracle');
    expect(followThroughText).toContain('review-only selector · manual execution required · not sent');
    expect(followThroughText).toContain('Next move: Ask oracle to review the edit benchmark review continuation: Edited internal continuation for Oracle review.');
    expect(followThroughText).toContain('Source continuation: edit · edited for internal review');
    expect(followThroughText).toContain('no command stored, runtime execution, external send, route flip, provider, account or token access, Telegram, or live hm-send');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('edit continuation metadata saved locally. Nothing was sent or executed.');

    const deliveryButton = harness.elements.routeFollowThroughList.children[0].children
      .find((child) => child.tagName === 'BUTTON');
    expect(deliveryButton.textContent).toBe('Preview delivery packet');
    await deliveryButton.listeners.click();

    const deliveryPreviewCalls = harness.calls.filter((call) => call.url === '/mission-control/internal-delivery-previews');
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
    expect(deliveryPreviewCalls).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({
        method: 'POST',
        body: {
          recommendationToken: 'mission-follow-through-test',
        },
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.some((call) => call.url === '/bridge/manual-plan')).toBe(false);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.routeDeliveryPreviewList.children).toHaveLength(1);
    const deliveryText = harness.elements.routeDeliveryPreviewList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(deliveryText).toContain('oracle · delivery preview');
    expect(deliveryText).toContain('reviewed preview only · preview/audit only · manual execution required · not sent');
    expect(deliveryText).toContain('Pane target: oracle pane 3');
    expect(deliveryText).toContain('Body: Edited internal continuation for Oracle review.');
    expect(deliveryText).toContain('Checksum: packet-sha256-test');
    expect(deliveryText).toContain('Review: Manual copy only: paste this body into oracle pane 3 after review.');
    expect(deliveryText).toContain('no command stored, runtime execution, external send, route flip, provider/model call, account or token access, Telegram, or live hm-send');
    const copyButton = harness.elements.routeDeliveryPreviewList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Copy packet body');
    expect(copyButton.textContent).toBe('Copy packet body');
    await copyButton.listeners.click();
    expect(harness.context.navigator.clipboard.writeText).toHaveBeenCalledWith('Edited internal continuation for Oracle review.');
    expect(copyButton.textContent).toBe('Copied body');
    const readinessButton = harness.elements.routeDeliveryPreviewList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Review dispatch readiness');
    expect(readinessButton.textContent).toBe('Review dispatch readiness');
    await readinessButton.listeners.click();

    const dispatchReadinessCalls = harness.calls.filter((call) => call.url === '/mission-control/dispatch-readiness');
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(5);
    expect(dispatchReadinessCalls).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({
        method: 'POST',
        body: {
          deliveryPreviewToken: 'mission-delivery-preview-test',
        },
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.elements.routeDispatchReadinessList.children).toHaveLength(1);
    const readinessText = harness.elements.routeDispatchReadinessList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(readinessText).toContain('oracle · dispatch readiness');
    expect(readinessText).toContain('ready for manual dispatch review · review/checklist only · manual execution required · not sent');
    expect(readinessText).toContain('Pane target: oracle pane 3');
    expect(readinessText).toContain('Copied body: Edited internal continuation for Oracle review.');
    expect(readinessText).toContain('Body checksum: body-sha256-test');
    expect(readinessText).toContain('Packet checksum: packet-sha256-test');
    expect(readinessText).toContain('Checksum match: yes');
    expect(readinessText).toContain('Copied pane body checksum matches the saved delivery preview body.');
    expect(readinessText).toContain('no command stored, hm-send execution, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    const dryRunButton = harness.elements.routeDispatchReadinessList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Create send dry run');
    expect(dryRunButton.textContent).toBe('Create send dry run');
    await dryRunButton.listeners.click();

    const dryRunCalls = harness.calls.filter((call) => call.url === '/mission-control/internal-send-dry-runs');
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(6);
    expect(dryRunCalls).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({
        method: 'POST',
        body: {
          dispatchReadinessToken: 'mission-dispatch-readiness-test',
        },
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.elements.routeInternalSendDryRunList.children).toHaveLength(1);
    const dryRunText = harness.elements.routeInternalSendDryRunList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(dryRunText).toContain('oracle · internal-send dry run');
    expect(dryRunText).toContain('dry run ready · adapter/audit only · manual execution required · not sent');
    expect(dryRunText).toContain('Pane target: oracle pane 3');
    expect(dryRunText).toContain('Body: Edited internal continuation for Oracle review.');
    expect(dryRunText).toContain('Adapter: hm-send dry-run via ui/scripts/hm-send.js');
    expect(dryRunText).toContain('Activation gate: separate_reviewed_activation');
    expect(dryRunText).toContain('no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    const activationDesignCallsBeforeClick = harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-designs');
    expect(activationDesignCallsBeforeClick).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-requests')).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    const activationDesignButton = harness.elements.routeInternalSendDryRunList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Design activation proof');
    expect(activationDesignButton.textContent).toBe('Design activation proof');
    await activationDesignButton.listeners.click();

    const activationDesignCalls = harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-designs');
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(7);
    expect(activationDesignCalls).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({
        method: 'POST',
        body: {
          internalSendDryRunToken: 'mission-send-dry-run-test',
        },
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.elements.routeInternalSendActivationDesignList.children).toHaveLength(1);
    const activationDesignText = harness.elements.routeInternalSendActivationDesignList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(activationDesignText).toContain('oracle · activation design');
    expect(activationDesignText).toContain('activation design review only · refusal/rollback/audit required · manual execution required · not sent');
    expect(activationDesignText).toContain('Pane target: oracle pane 3');
    expect(activationDesignText).toContain('Body: Edited internal continuation for Oracle review.');
    expect(activationDesignText).toContain('Activation gate: separate_reviewed_activation; activation allowed: no');
    expect(activationDesignText).toContain('Missing or unknown internal-send dry-run tokens must return 400 without writing.');
    expect(activationDesignText).toContain('Future activation must snapshot the dry-run token, target, body checksum, and adapter checksum before any execution.');
    expect(activationDesignText).toContain('design/proof only; durable audit, refusal, and rollback requirements are visible; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    const activationRequestCallsBeforeClick = harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-requests');
    expect(activationRequestCallsBeforeClick).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    const activationRequestButton = harness.elements.routeInternalSendActivationDesignList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Preview activation request');
    expect(activationRequestButton.textContent).toBe('Preview activation request');
    await activationRequestButton.listeners.click();

    const activationRequestCalls = harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-requests');
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(8);
    expect(activationRequestCalls).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({
        method: 'POST',
        body: {
          internalSendActivationDesignToken: 'mission-send-activation-design-test',
        },
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.elements.routeInternalSendActivationRequestList.children).toHaveLength(1);
    const activationRequestText = harness.elements.routeInternalSendActivationRequestList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(activationRequestText).toContain('oracle · activation request preview');
    expect(activationRequestText).toContain('activation request review only · reviewer/refusal/rollback/audit required · manual execution required · not sent');
    expect(activationRequestText).toContain('Pane target: oracle pane 3');
    expect(activationRequestText).toContain('Body: Edited internal continuation for Oracle review.');
    expect(activationRequestText).toContain('Reviewer: architect_or_oracle · pending review');
    expect(activationRequestText).toContain('Activation request: separate_reviewed_activation; activation allowed: no');
    expect(activationRequestText).toContain('Missing or unknown activation-design tokens must return 400 without writing.');
    expect(activationRequestText).toContain('A later activation must define rollback/failure handling before execution is allowed.');
    expect(activationRequestText).toContain('request preview only; reviewer, refusal, rollback, and audit fields are visible; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    const activationAuditCallsBeforeClick = harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-decision-audits');
    expect(activationAuditCallsBeforeClick.every((call) => call.method === 'GET')).toBe(true);
    expect(activationAuditCallsBeforeClick).toHaveLength(9);
    const activationAuditButton = harness.elements.routeInternalSendActivationRequestList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Record decision audit');
    expect(activationAuditButton.textContent).toBe('Record decision audit');
    await activationAuditButton.listeners.click();

    const activationAuditCalls = harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-decision-audits');
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(9);
    expect(activationAuditCalls).toEqual([
      ...Array.from({ length: 9 }, () => expect.objectContaining({ method: 'GET' })),
      expect.objectContaining({
        method: 'POST',
        body: {
          internalSendActivationRequestToken: 'mission-send-activation-request-test',
        },
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.elements.routeInternalSendActivationAuditList.children).toHaveLength(1);
    const activationAuditText = harness.elements.routeInternalSendActivationAuditList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(activationAuditText).toContain('oracle · activation decision audit');
    expect(activationAuditText).toContain('activation decision audit review only · refusal/rollback audit · manual execution required · not sent');
    expect(activationAuditText).toContain('Pane target: oracle pane 3');
    expect(activationAuditText).toContain('Body: Edited internal continuation for Oracle review.');
    expect(activationAuditText).toContain('Reviewer: architect_or_oracle · pending review');
    expect(activationAuditText).toContain('Decision: refuse live activation until separate gate; activation allowed: no');
    expect(activationAuditText).toContain('Refusal: refused_for_live_execution · No live hm-send execution is allowed from this review-only audit artifact.');
    expect(activationAuditText).toContain('Rollback audit: rollback_audit_previewed · snapshot: required · failure audit: required');
    expect(activationAuditText).toContain('decision/refusal/rollback audit only; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    const implementationReadinessCallsBeforeClick = harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-implementation-readiness');
    expect(implementationReadinessCallsBeforeClick.every((call) => call.method === 'GET')).toBe(true);
    expect(implementationReadinessCallsBeforeClick).toHaveLength(10);
    const implementationReadinessButton = harness.elements.routeInternalSendActivationAuditList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Check implementation readiness');
    expect(implementationReadinessButton.textContent).toBe('Check implementation readiness');
    await implementationReadinessButton.listeners.click();

    const implementationReadinessCalls = harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-implementation-readiness');
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(10);
    expect(implementationReadinessCalls).toEqual([
      ...Array.from({ length: 10 }, () => expect.objectContaining({ method: 'GET' })),
      expect.objectContaining({
        method: 'POST',
        body: {
          internalSendActivationDecisionAuditToken: 'mission-send-activation-audit-test',
        },
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.elements.routeInternalSendActivationReadinessList.children).toHaveLength(1);
    const implementationReadinessText = harness.elements.routeInternalSendActivationReadinessList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(implementationReadinessText).toContain('oracle · activation implementation readiness');
    expect(implementationReadinessText).toContain('activation implementation readiness review only · disabled by default · refusal/rollback/audit required · not sent');
    expect(implementationReadinessText).toContain('Pane target: oracle pane 3');
    expect(implementationReadinessText).toContain('Body: Edited internal continuation for Oracle review.');
    expect(implementationReadinessText).toContain('Implementation gate: enabled: no; activation allowed: no; live hm-send: no');
    expect(implementationReadinessText).toContain('Refusal: live_activation_still_refused · Implementation readiness is review-only and remains disabled until a separate activation implementation gate exists.');
    expect(implementationReadinessText).toContain('Rollback: rollback_requirements_ready · snapshot: required · failure audit: required');
    expect(implementationReadinessText).toContain('implementation readiness only; disabled by default; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    expect(harness.calls.some((call) => call.url === '/bridge/manual-plan')).toBe(false);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Internal delivery preview saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Dispatch-readiness checklist saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Internal-send dry-run audit saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Activation-design proof saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Activation request preview saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Activation decision audit saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Activation implementation readiness saved locally. Nothing was sent or executed.');
  });

  test('answers the Mission Control question locally from SquidRun evidence without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.turnText.value = 'what is happening here, and what happens next?';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCalls).toHaveLength(0);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toEqual([
      'what is happening here, and what happens next?',
      expect.stringContaining('Project/lane: squidrun / architect#253.'),
    ]);
    const missionReply = harness.elements.thread.children[1].children[0].textContent;
    expect(missionReply).toContain('Next team move: Builder implements Mission Control v0; Oracle reviews it against the benchmark before commit.');
    expect(missionReply).toContain('Foundation vs product: SquidRun context is foundation.');
    expect((missionReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
    expect(harness.elements.lastTurn.textContent).toBe('mission control local');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('posts exactly one deterministic turn after explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.calls.every((call) => call.method === 'GET')).toBe(true);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'Who are you?';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const turnCalls = harness.calls.filter((call) => call.url === '/turn');
    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCalls).toHaveLength(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].body).toEqual(expect.objectContaining({
      text: 'Who are you?',
      useModel: false,
      modelProvider: 'openai_responses',
      modelName: 'gpt-5.5',
    }));
    expect(turnCalls[0].body.sessionId).toMatch(/^mira-ui-\d+$/);
    expect(turnCalls[0].body.messageId).toBe(`${turnCalls[0].body.sessionId}-turn-0`);
    expect(harness.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/conversation/memory', method: 'GET' }),
    ]));
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toEqual([
      'Who are you?',
      'Mira. Deterministic local turn.',
    ]);
    expect(harness.elements.lastTurn.textContent).toBe('deterministic');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('renders held replies from the public visible reply without leaking gate labels', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const heldText = 'That answer came out wrong, so I am holding it instead of making you clean it up.';
    const rejectedGeneratedText = 'The validation fixture and proof scaffolding show the route owner protocol.';
    const harness = createRuntimeBootHarness({
      allowTurn: true,
      turnPayload: (body, defaultPayload) => ({
        ...defaultPayload,
        input: {
          text: body?.text || '',
          sessionId: body?.sessionId || null,
        },
        response: {
          role: 'mira',
          content: heldText,
        },
        visibleReply: {
          role: 'mira',
          content: heldText,
          held: true,
        },
        visibleReplyStatus: {
          checked: true,
          held: true,
          reason: 'held_for_visible_reply_quality',
          visibleContentReplaced: true,
          rejectedTextVisible: false,
          violationIdsVisible: false,
          diagnosticsVisible: false,
        },
        visibleReplyGate: {
          ok: false,
          checked: true,
          held: true,
          violations: ['backstage_label'],
          source: 'mira_runtime_visible_reply_gate_v0',
        },
        heldReplyAudit: {
          schema: 'mira.runtime_held_reply_audit.v0',
          checked: true,
          held: true,
          reason: 'visible_reply_gate_violation',
          journalStoresRejectedText: false,
          rejectedGeneratedText,
        },
      }),
    });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'Say something shaped wrong.';
    await harness.elements.turnForm.listeners.submit({ preventDefault: jest.fn() });

    const renderedText = harness.elements.thread.children
      .map((node) => node.children[0].textContent)
      .join('\n');
    expect(renderedText).toContain('Say something shaped wrong.');
    expect(renderedText).toContain(heldText);
    expect(renderedText).not.toContain('backstage_label');
    expect(renderedText).not.toContain('mira_runtime_visible_reply_gate_v0');
    expect(renderedText).not.toContain('visible_reply_gate_violation');
    expect(renderedText).not.toContain('validation fixture');
    expect(renderedText).not.toContain('proof scaffolding');
    expect(renderedText).not.toContain('route owner protocol');
  });
});
