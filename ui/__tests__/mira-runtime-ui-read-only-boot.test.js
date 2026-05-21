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
      .find((child) => child.tagName === 'BUTTON');
    expect(copyButton.textContent).toBe('Copy packet body');
    await copyButton.listeners.click();
    expect(harness.context.navigator.clipboard.writeText).toHaveBeenCalledWith('Edited internal continuation for Oracle review.');
    expect(copyButton.textContent).toBe('Copied body');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Internal delivery preview saved locally. Nothing was sent or executed.');
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
