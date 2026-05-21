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
    '/mission-control/internal-send-live-activation-gate-contracts': {
      ok: true,
      protocol: 'mira.mission_control_internal_send_live_activation_gate_contract_list.v0',
      contractCount: 0,
      contracts: [],
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
  const activationStageDefinitions = [
    ['route_preview', 'Route preview', '/mission-control/route-previews', 'previews', 'previewCount', 'saved'],
    ['internal_route_request', 'Review item', '/mission-control/internal-route-requests', 'requests', 'requestCount', 'saved'],
    ['owned_work_continuation', 'Owned-work continuation', '/mission-control/owned-work-continuations', 'continuations', 'continuationCount', 'saved'],
    ['follow_through_recommendation', 'Follow-through recommendation', '/mission-control/follow-through-recommendations', 'recommendations', 'recommendationCount', 'derived'],
    ['internal_delivery_preview', 'Delivery preview', '/mission-control/internal-delivery-previews', 'previews', 'previewCount', 'saved'],
    ['dispatch_readiness', 'Dispatch readiness', '/mission-control/dispatch-readiness', 'readiness', 'readinessCount', 'saved'],
    ['internal_send_dry_run', 'Internal-send dry run', '/mission-control/internal-send-dry-runs', 'dryRuns', 'dryRunCount', 'saved'],
    ['activation_design', 'Activation design', '/mission-control/internal-send-activation-designs', 'designs', 'designCount', 'saved'],
    ['activation_request', 'Activation request', '/mission-control/internal-send-activation-requests', 'requests', 'requestCount', 'saved'],
    ['activation_decision_audit', 'Decision audit', '/mission-control/internal-send-activation-decision-audits', 'audits', 'auditCount', 'saved'],
    ['activation_implementation_readiness', 'Implementation readiness', '/mission-control/internal-send-activation-implementation-readiness', 'readiness', 'readinessCount', 'saved'],
    ['live_activation_gate_contract', 'Live activation hard-stop contract', '/mission-control/internal-send-live-activation-gate-contracts', 'contracts', 'contractCount', 'saved'],
  ];
  const activationStageSources = {
    internal_route_request: ['route_preview', 'sourcePreviewToken'],
    owned_work_continuation: ['internal_route_request', 'sourceRequestToken'],
    follow_through_recommendation: ['owned_work_continuation', 'sourceContinuationToken'],
    internal_delivery_preview: ['follow_through_recommendation', 'sourceRecommendationToken'],
    dispatch_readiness: ['internal_delivery_preview', 'sourceDeliveryPreviewToken'],
    internal_send_dry_run: ['dispatch_readiness', 'sourceDispatchReadinessToken'],
    activation_design: ['internal_send_dry_run', 'sourceInternalSendDryRunToken'],
    activation_request: ['activation_design', 'sourceInternalSendActivationDesignToken'],
    activation_decision_audit: ['activation_request', 'sourceInternalSendActivationRequestToken'],
    activation_implementation_readiness: ['activation_decision_audit', 'sourceInternalSendActivationDecisionAuditToken'],
    live_activation_gate_contract: ['activation_implementation_readiness', 'sourceInternalSendActivationImplementationReadinessToken'],
  };
  const buildActivationPipelineStatus = () => {
    const stages = activationStageDefinitions.map(([id, label, endpoint, listKey, countKey, availableStatus]) => {
      const payload = payloads[endpoint];
      const records = Array.isArray(payload?.[listKey]) ? payload[listKey] : [];
      const record = id === 'follow_through_recommendation'
        ? payload?.selectedRecommendation
        : records[0];
      const status = record ? availableStatus : 'missing';
      const latestStatus = record?.status || null;
      const source = activationStageSources[id] || [null, null];
      const relativePath = record && id !== 'follow_through_recommendation'
        ? `${endpoint.replace('/mission-control/', 'mission-control/')}/${record.id}.json`
        : null;
      return {
        id,
        label,
        protocol: record?.protocol || null,
        status,
        count: Number(payload?.[countKey] || records.length || 0),
        latestId: record?.id || null,
        latestToken: record?.actionToken || null,
        latestStatus,
        relativePath,
        sourceStageId: record ? source[0] : null,
        sourceToken: record && source[1] ? record[source[1]] || null : null,
        latestCreatedAt: record?.createdAt || null,
        targetRole: record?.targetRole || null,
        targetPaneId: record?.targetPaneId || null,
        targetLabel: record?.targetLabel || null,
        contentPreview: record?.contentPreview || record?.content || null,
        missionAnswerPreview: record?.missionAnswerPreview || null,
        bodySha256: record?.bodySha256 || null,
        adapterPacketSha256: record?.adapterPacketSha256 || null,
        summary: record
          ? `${label}: ${String(latestStatus || status).replace(/_/g, ' ')}; token ${record.actionToken || 'not available'}.`
          : `${label}: not saved yet.`,
        hardStop: record?.hardStop
          ? {
            liveActivationAllowed: false,
            liveHmSendExecutionAllowed: false,
            realSendAllowed: false,
            implementationEnabled: false,
            separateActivationLaneRequired: record.hardStop.separateActivationLaneRequired === true,
            jamesSetupRequiredBeforeLiveSend: record.hardStop.jamesSetupRequiredBeforeLiveSend === true,
          }
          : null,
      };
    });
    const currentStage = [...stages].reverse().find((stage) => stage.status !== 'missing') || null;
    const lastSavedArtifact = [...stages].reverse().find((stage) => stage.status === 'saved') || null;
    const hardStopContractRecorded = stages.find((stage) => stage.id === 'live_activation_gate_contract')?.status === 'saved';
    const traceEntries = stages
      .filter((stage) => stage.status !== 'missing')
      .map((stage) => ({
        stageId: stage.id,
        label: stage.label,
        status: stage.status,
        token: stage.latestToken,
        relativePath: stage.relativePath,
        sourceStageId: stage.sourceStageId,
        sourceToken: stage.sourceToken,
        createdAt: stage.latestCreatedAt,
        targetRole: stage.targetRole,
        contentPreview: stage.contentPreview,
        missionAnswerPreview: stage.missionAnswerPreview,
        bodySha256: stage.bodySha256,
        adapterPacketSha256: stage.adapterPacketSha256,
        summary: stage.summary,
      }));
    const availableStages = stages.filter((stage) => stage.status !== 'missing');
    const firstMissingIndex = stages.findIndex((stage) => stage.status === 'missing');
    const hardStopReached = firstMissingIndex === -1
      && stages.some((stage) => stage.id === 'live_activation_gate_contract' && stage.status !== 'missing');
    const selectedStage = hardStopReached
      ? stages.find((stage) => stage.id === 'live_activation_gate_contract')
      : firstMissingIndex > 0
        ? stages[firstMissingIndex - 1]
        : null;
    const nextStage = hardStopReached
      ? null
      : firstMissingIndex >= 0
        ? stages[firstMissingIndex]
        : null;
    const selectionStatus = hardStopReached
      ? 'hard_stop_reached'
      : selectedStage && nextStage
        ? 'advance_available'
        : 'no_chain';
    const selectionReason = selectionStatus === 'hard_stop_reached'
      ? 'The chain is already at the live activation hard-stop contract. This read-only surface has no next artifact to advance; future real send would require a separate James-visible setup/activation lane.'
      : selectionStatus === 'advance_available'
        ? `${selectedStage.label} is the latest available stage before the first missing stage, ${nextStage.label}.`
        : 'No saved Mission Control route preview exists yet, so there is no artifact to advance.';
    const missingStageLabels = stages.filter((stage) => stage.status === 'missing').map((stage) => stage.label);
    const readoutStatus = hardStopContractRecorded
      ? 'terminal_hard_stop'
      : currentStage
        ? 'in_progress'
        : 'empty';
    const readoutHeadline = readoutStatus === 'terminal_hard_stop'
      ? 'Mission Control send chain is complete to the hard stop; live send is unavailable.'
      : readoutStatus === 'in_progress'
        ? `Mission Control send chain is at ${currentStage.label}; the next step remains manual-only.`
        : 'Mission Control send chain has no saved artifact yet.';
    const stageNext = (stageId) => {
      const index = activationStageDefinitions.findIndex(([id]) => id === stageId);
      const next = index >= 0 ? activationStageDefinitions[index + 1] : null;
      return next ? { id: next[0], label: next[1] } : null;
    };
    const originStage = availableStages.find((stage) => stage.id === 'route_preview' && stage.missionAnswerPreview)
      || availableStages.find((stage) => stage.missionAnswerPreview)
      || null;
    const originatingAnswerPreview = originStage?.missionAnswerPreview || null;
    const missionAnswerTrail = availableStages.map((stage) => ({
      stageId: stage.id,
      label: stage.label,
      status: stage.status,
      token: stage.latestToken,
      relativePath: stage.relativePath,
      sourceStageId: stage.sourceStageId,
      sourceToken: stage.sourceToken,
      missionAnswerPreview: stage.missionAnswerPreview,
      matchesOriginatingAnswer: Boolean(originatingAnswerPreview) && stage.missionAnswerPreview === originatingAnswerPreview,
    }));
    const missionAnswerMatchingCount = missionAnswerTrail.filter((entry) => entry.matchesOriginatingAnswer).length;
    const missionAnswerMissingLabels = missionAnswerTrail
      .filter((entry) => !entry.missionAnswerPreview)
      .map((entry) => entry.label);
    const missionAnswerMismatchedLabels = missionAnswerTrail
      .filter((entry) => entry.missionAnswerPreview && !entry.matchesOriginatingAnswer)
      .map((entry) => entry.label);
    const missionAnswerContinuityStatus = !originatingAnswerPreview
      ? 'empty'
      : missionAnswerMatchingCount === availableStages.length
        ? 'complete'
        : 'partial';
    const missionAnswerContinuitySummary = missionAnswerContinuityStatus === 'complete'
      ? `Same originating Mission Control answer appears across ${missionAnswerMatchingCount}/${availableStages.length} available stages from ${missionAnswerTrail[0]?.label || 'no saved stage'} to ${missionAnswerTrail[missionAnswerTrail.length - 1]?.label || 'no saved stage'}.`
      : missionAnswerContinuityStatus === 'partial'
        ? `Mission answer continuity is partial: ${missionAnswerMatchingCount}/${availableStages.length} available stages match the originating answer; missing ${missionAnswerMissingLabels.join(', ') || 'none'}; mismatched ${missionAnswerMismatchedLabels.join(', ') || 'none'}.`
        : 'No originating Mission Control answer is attached to the saved activation pipeline yet.';
    return {
      ok: true,
      protocol: 'mira.mission_control_activation_pipeline_status.v0',
      stateRootPath: null,
      currentStage,
      currentStageId: currentStage?.id || null,
      currentStageLabel: currentStage?.label || 'No Mission Control send chain yet',
      lastSavedArtifact,
      stageCount: stages.length,
      stages,
      currentStageTrace: {
        protocol: 'mira.mission_control_activation_pipeline_trace.v0',
        entryCount: traceEntries.length,
        currentStageId: currentStage?.id || null,
        currentArtifactToken: currentStage?.latestToken || null,
        sourcePath: traceEntries.length
          ? traceEntries.map((entry) => entry.label).join(' -> ')
          : 'No saved Mission Control activation artifacts yet.',
        entries: traceEntries,
        noEffectSummary: 'Read-only trace only; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery.',
      },
      advanceSelection: {
        protocol: 'mira.mission_control_activation_pipeline_advance_selection.v0',
        status: selectionStatus,
        selectedStageId: selectedStage?.id || null,
        selectedStageLabel: selectedStage?.label || null,
        selectedArtifactToken: selectedStage?.latestToken || null,
        selectedRelativePath: selectedStage?.relativePath || null,
        selectedArtifactStatus: selectedStage?.status || null,
        selectedSourceStageId: selectedStage?.sourceStageId || null,
        selectedSourceToken: selectedStage?.sourceToken || null,
        selectedBodySha256: selectedStage?.bodySha256 || null,
        selectedAdapterPacketSha256: selectedStage?.adapterPacketSha256 || null,
        nextStageId: nextStage?.id || null,
        nextStageLabel: nextStage?.label || null,
        reason: selectionReason,
        comparisonSummary: selectionStatus === 'hard_stop_reached'
          ? `Compared ${availableStages.length} available stage(s); no advancement is available after the hard-stop contract.`
          : selectionStatus === 'advance_available'
            ? `Compared ${availableStages.length} available stage(s); selected ${selectedStage.label} because ${nextStage.label} is the first missing stage.`
            : 'Compared 0 available stages; start by saving a route preview.',
        candidates: availableStages.map((stage) => {
          const next = stageNext(stage.id);
          return {
            stageId: stage.id,
            label: stage.label,
            token: stage.latestToken,
            relativePath: stage.relativePath,
            status: stage.status,
            selected: selectedStage?.id === stage.id,
            nextStageId: next?.id || null,
            nextStageLabel: next?.label || null,
            reason: selectedStage?.id === stage.id
              ? selectionReason
              : `${stage.label} is available evidence, but ${selectedStage?.label || 'no saved artifact'} is the current selection.`,
          };
        }),
        noEffectSummary: 'Read-only selection aid only; it compares existing trace entries and does not persist a selection, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.',
      },
      manualActionPreflight: (() => {
        const actionMap = {
          route_preview: ['Make review item', 'previewToken'],
          internal_route_request: ['Review continuation', 'requestToken'],
          follow_through_recommendation: ['Preview delivery packet', 'recommendationToken'],
          internal_delivery_preview: ['Review dispatch readiness', 'deliveryPreviewToken'],
          dispatch_readiness: ['Create send dry run', 'dispatchReadinessToken'],
          internal_send_dry_run: ['Design activation proof', 'internalSendDryRunToken'],
          activation_design: ['Preview activation request', 'internalSendActivationDesignToken'],
          activation_request: ['Record decision audit', 'internalSendActivationRequestToken'],
          activation_decision_audit: ['Check implementation readiness', 'internalSendActivationDecisionAuditToken'],
          activation_implementation_readiness: ['Define live gate contract', 'internalSendActivationImplementationReadinessToken'],
        };
        const action = actionMap[selectedStage?.id] || null;
        const status = selectionStatus === 'hard_stop_reached'
          ? 'blocked_hard_stop'
          : selectedStage && nextStage && action
            ? 'ready'
            : 'blocked_no_source';
        const explanation = status === 'ready'
          ? `${action[0]} is the next manual internal action because ${selectedStage.label} is selected and ${nextStage.label} is the first missing stage. Use the selected token as ${action[1]}; this preflight does not perform the action.`
          : status === 'blocked_hard_stop'
            ? 'No manual advancement is available from this read-only surface because the selected artifact is the live activation hard-stop contract.'
            : 'No manual action is ready because there is no selected saved artifact with a token and next missing stage.';
        return {
          protocol: 'mira.mission_control_activation_pipeline_manual_action_preflight.v0',
          status,
          selectedStageId: selectedStage?.id || null,
          selectedStageLabel: selectedStage?.label || null,
          selectedArtifactToken: selectedStage?.latestToken || null,
          selectedRelativePath: selectedStage?.relativePath || null,
          nextStageId: nextStage?.id || null,
          nextStageLabel: nextStage?.label || null,
          manualActionLabel: status === 'ready' ? action[0] : null,
          manualActionSurface: status === 'ready' ? 'mission_control_workbench' : null,
          tokenField: status === 'ready' ? action[1] : null,
          tokenValue: status === 'ready' ? selectedStage.latestToken : null,
          explanation,
          evidenceChecks: [
            { id: 'selected_artifact_token_present', label: 'Selected artifact token is available.', ok: Boolean(selectedStage?.latestToken) },
            { id: 'selected_artifact_path_present', label: 'Selected artifact path is available or the selected entry is derived.', ok: Boolean(selectedStage?.relativePath) || selectedStage?.status === 'derived' },
            { id: 'next_stage_missing', label: 'A next missing stage exists for manual advancement.', ok: Boolean(nextStage) },
            { id: 'not_hard_stop', label: 'Selected artifact is not the live activation hard-stop contract.', ok: selectionStatus !== 'hard_stop_reached' },
            { id: 'preflight_is_read_only', label: 'Preflight is derived from GET status and does not persist or execute anything.', ok: true },
          ],
          noEffectSummary: 'Read-only preflight only; it explains the next manual internal action and does not persist, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.',
        };
      })(),
      payloadPreview: (() => {
        const actionMap = {
          route_preview: {
            label: 'Make review item',
            endpoint: '/mission-control/internal-route-requests',
            payload: { previewToken: selectedStage?.latestToken || '' },
            requiredManualInputs: [],
          },
          internal_route_request: {
            label: 'Review continuation',
            endpoint: '/mission-control/owned-work-continuations',
            payload: {
              requestToken: selectedStage?.latestToken || '',
              decision: '<approve|edit|reject>',
              editedContent: '<review text when editing>',
              note: '<optional note>',
            },
            requiredManualInputs: ['decision', 'editedContent when decision is edit', 'optional note'],
          },
          follow_through_recommendation: {
            label: 'Preview delivery packet',
            endpoint: '/mission-control/internal-delivery-previews',
            payload: { recommendationToken: selectedStage?.latestToken || '' },
            requiredManualInputs: [],
          },
          internal_delivery_preview: {
            label: 'Review dispatch readiness',
            endpoint: '/mission-control/dispatch-readiness',
            payload: { deliveryPreviewToken: selectedStage?.latestToken || '' },
            requiredManualInputs: [],
          },
          dispatch_readiness: {
            label: 'Create send dry run',
            endpoint: '/mission-control/internal-send-dry-runs',
            payload: { dispatchReadinessToken: selectedStage?.latestToken || '' },
            requiredManualInputs: [],
          },
          internal_send_dry_run: {
            label: 'Design activation proof',
            endpoint: '/mission-control/internal-send-activation-designs',
            payload: { internalSendDryRunToken: selectedStage?.latestToken || '' },
            requiredManualInputs: [],
          },
          activation_design: {
            label: 'Preview activation request',
            endpoint: '/mission-control/internal-send-activation-requests',
            payload: { internalSendActivationDesignToken: selectedStage?.latestToken || '' },
            requiredManualInputs: [],
          },
          activation_request: {
            label: 'Record decision audit',
            endpoint: '/mission-control/internal-send-activation-decision-audits',
            payload: { internalSendActivationRequestToken: selectedStage?.latestToken || '' },
            requiredManualInputs: [],
          },
          activation_decision_audit: {
            label: 'Check implementation readiness',
            endpoint: '/mission-control/internal-send-activation-implementation-readiness',
            payload: { internalSendActivationDecisionAuditToken: selectedStage?.latestToken || '' },
            requiredManualInputs: [],
          },
          activation_implementation_readiness: {
            label: 'Define live gate contract',
            endpoint: '/mission-control/internal-send-live-activation-gate-contracts',
            payload: { internalSendActivationImplementationReadinessToken: selectedStage?.latestToken || '' },
            requiredManualInputs: [],
          },
        };
        const handlerMap = {
          route_preview: {
            handlerName: 'createRouteRequestFromPreview',
            handlerSource: 'mira/ui/app.js:createRouteRequestFromPreview',
            method: 'POST',
            endpoint: '/mission-control/internal-route-requests',
            tokenField: 'previewToken',
            bodyFields: ['previewToken'],
          },
          internal_route_request: {
            handlerName: 'createOwnedWorkContinuation',
            handlerSource: 'mira/ui/app.js:createOwnedWorkContinuation',
            method: 'POST',
            endpoint: '/mission-control/owned-work-continuations',
            tokenField: 'requestToken',
            bodyFields: ['requestToken', 'decision', 'editedContent', 'note'],
          },
          follow_through_recommendation: {
            handlerName: 'createInternalDeliveryPreview',
            handlerSource: 'mira/ui/app.js:createInternalDeliveryPreview',
            method: 'POST',
            endpoint: '/mission-control/internal-delivery-previews',
            tokenField: 'recommendationToken',
            bodyFields: ['recommendationToken'],
          },
          internal_delivery_preview: {
            handlerName: 'createDispatchReadiness',
            handlerSource: 'mira/ui/app.js:createDispatchReadiness',
            method: 'POST',
            endpoint: '/mission-control/dispatch-readiness',
            tokenField: 'deliveryPreviewToken',
            bodyFields: ['deliveryPreviewToken'],
          },
          dispatch_readiness: {
            handlerName: 'createInternalSendDryRun',
            handlerSource: 'mira/ui/app.js:createInternalSendDryRun',
            method: 'POST',
            endpoint: '/mission-control/internal-send-dry-runs',
            tokenField: 'dispatchReadinessToken',
            bodyFields: ['dispatchReadinessToken'],
          },
          internal_send_dry_run: {
            handlerName: 'createInternalSendActivationDesign',
            handlerSource: 'mira/ui/app.js:createInternalSendActivationDesign',
            method: 'POST',
            endpoint: '/mission-control/internal-send-activation-designs',
            tokenField: 'internalSendDryRunToken',
            bodyFields: ['internalSendDryRunToken'],
          },
          activation_design: {
            handlerName: 'createInternalSendActivationRequest',
            handlerSource: 'mira/ui/app.js:createInternalSendActivationRequest',
            method: 'POST',
            endpoint: '/mission-control/internal-send-activation-requests',
            tokenField: 'internalSendActivationDesignToken',
            bodyFields: ['internalSendActivationDesignToken'],
          },
          activation_request: {
            handlerName: 'createInternalSendActivationDecisionAudit',
            handlerSource: 'mira/ui/app.js:createInternalSendActivationDecisionAudit',
            method: 'POST',
            endpoint: '/mission-control/internal-send-activation-decision-audits',
            tokenField: 'internalSendActivationRequestToken',
            bodyFields: ['internalSendActivationRequestToken'],
          },
          activation_decision_audit: {
            handlerName: 'createInternalSendActivationImplementationReadiness',
            handlerSource: 'mira/ui/app.js:createInternalSendActivationImplementationReadiness',
            method: 'POST',
            endpoint: '/mission-control/internal-send-activation-implementation-readiness',
            tokenField: 'internalSendActivationDecisionAuditToken',
            bodyFields: ['internalSendActivationDecisionAuditToken'],
          },
          activation_implementation_readiness: {
            handlerName: 'createInternalSendLiveActivationGateContract',
            handlerSource: 'mira/ui/app.js:createInternalSendLiveActivationGateContract',
            method: 'POST',
            endpoint: '/mission-control/internal-send-live-activation-gate-contracts',
            tokenField: 'internalSendActivationImplementationReadinessToken',
            bodyFields: ['internalSendActivationImplementationReadinessToken'],
          },
        };
        const action = actionMap[selectedStage?.id] || null;
        const handler = handlerMap[selectedStage?.id] || null;
        const preflightReady = selectionStatus === 'advance_available' && Boolean(action);
        const status = !preflightReady ? 'blocked' : action.requiredManualInputs.length > 0 ? 'needs_manual_input' : 'ready';
        const explanation = status === 'ready'
          ? `This is the exact workbench payload preview for ${action.label}; it is not submitted by the status surface.`
          : status === 'needs_manual_input'
            ? `This payload skeleton needs manual input before ${action.label} can be submitted from the workbench.`
            : 'No payload preview is available because the manual action preflight is blocked.';
        const previewBodyFields = action ? Object.keys(action.payload) : [];
        const previewTokenField = action && handler ? previewBodyFields.find((field) => field === handler.tokenField) || null : null;
        const methodMatches = Boolean(handler && action && handler.method === 'POST');
        const endpointMatches = Boolean(handler && action && handler.endpoint === action.endpoint);
        const tokenFieldMatches = Boolean(handler && action && previewTokenField === handler.tokenField);
        const bodyShapeMatches = Boolean(handler && previewBodyFields.length === handler.bodyFields.length && previewBodyFields.every((field) => handler.bodyFields.includes(field)));
        const handlerMatched = preflightReady && methodMatches && endpointMatches && tokenFieldMatches && bodyShapeMatches;
        const handlerStatus = !preflightReady || !handler || !action ? 'blocked' : handlerMatched ? 'matched' : 'mismatched';
        return {
          protocol: 'mira.mission_control_activation_pipeline_payload_preview.v0',
          status,
          actionLabel: preflightReady ? action.label : null,
          method: action ? 'POST' : null,
          endpoint: action?.endpoint || null,
          payload: action?.payload || null,
          requiredManualInputs: action?.requiredManualInputs || [],
          selectedStageId: selectedStage?.id || null,
          selectedArtifactToken: selectedStage?.latestToken || null,
          selectedRelativePath: selectedStage?.relativePath || null,
          explanation,
          handlerDriftCheck: {
            protocol: 'mira.mission_control_workbench_handler_drift_check.v0',
            status: handlerStatus,
            handlerName: handler?.handlerName || null,
            handlerSource: handler?.handlerSource || null,
            actionLabel: preflightReady ? action.label : null,
            expectedMethod: handler?.method || null,
            previewMethod: action ? 'POST' : null,
            expectedEndpoint: handler?.endpoint || null,
            previewEndpoint: action?.endpoint || null,
            expectedTokenField: handler?.tokenField || null,
            previewTokenField,
            expectedBodyFields: handler?.bodyFields || [],
            previewBodyFields,
            explanation: handlerStatus === 'matched'
              ? `${handler.handlerName} expects POST ${handler.endpoint} with ${handler.tokenField}; payload preview matches that workbench handler contract.`
              : handlerStatus === 'mismatched'
                ? 'Payload preview does not match the static workbench handler expectation for this selected stage.'
                : 'No workbench handler drift check is available because the manual action preflight is blocked.',
            checks: [
              { id: 'manual_preflight_ready', label: 'Manual action preflight is ready.', ok: preflightReady },
              { id: 'handler_method_matches_preview', label: 'Workbench handler method matches the payload preview method.', ok: methodMatches },
              { id: 'handler_endpoint_matches_preview', label: 'Workbench handler endpoint matches the payload preview endpoint.', ok: endpointMatches },
              { id: 'handler_token_field_matches_preview', label: 'Workbench handler token field matches the payload preview token field.', ok: tokenFieldMatches },
              { id: 'handler_body_shape_matches_preview', label: 'Workbench handler body shape matches the payload preview body shape.', ok: bodyShapeMatches },
              { id: 'handler_drift_check_read_only', label: 'Drift check is derived from GET status and does not submit the handler.', ok: true },
            ],
            noEffectSummary: 'Read-only workbench handler drift check only; it compares endpoint and token-field expectations and does not submit, persist, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.',
          },
          validationChecks: [
            { id: 'manual_preflight_ready', label: 'Manual action preflight is ready.', ok: preflightReady },
            { id: 'endpoint_known', label: 'Existing workbench endpoint is known.', ok: Boolean(action?.endpoint) },
            { id: 'selected_token_present', label: 'Selected artifact token is present in the preview payload.', ok: preflightReady && Boolean(selectedStage?.latestToken) },
            { id: 'payload_preview_read_only', label: 'Payload preview is derived from GET status and is not submitted or persisted.', ok: true },
          ],
          noEffectSummary: 'Read-only payload preview only; it validates the existing workbench action payload shape and does not persist, submit, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.',
        };
      })(),
      endToEndReadout: {
        protocol: 'mira.mission_control_activation_pipeline_end_to_end_readout.v0',
        status: readoutStatus,
        headline: readoutHeadline,
        completedChainSummary: missingStageLabels.length === 0
          ? `${availableStages.length}/${stages.length} stages have saved or derived local evidence.`
          : `${availableStages.length}/${stages.length} stages have saved or derived local evidence; missing ${missingStageLabels.join(', ')}.`,
        currentHardStopTruth: `liveSendAvailable:false; hardStopRecorded:${hardStopContractRecorded}; jamesSetupRequiredBeforeLiveSend:true.`,
        provenSummary: readoutStatus === 'terminal_hard_stop'
          ? 'Saved local evidence covers route preview through live activation hard-stop contract; the status refresh is read-only and no next artifact is available.'
          : currentStage
            ? `Saved local evidence currently reaches ${currentStage.label}; the next workbench action is ${selectionStatus === 'advance_available' ? 'ready' : 'not ready'}.`
            : 'No saved chain evidence exists yet.',
        manualOnlySummary: readoutStatus === 'terminal_hard_stop'
          ? 'All advancement before the hard stop used explicit workbench actions; this readout has no submit, send, execution, provider, route, account, or token path.'
          : selectionStatus === 'advance_available'
            ? 'The next existing workbench action remains manual-only; this readout only explains it.'
            : 'No manual advancement is ready from this readout.',
        nextBoundary: hardStopContractRecorded
          ? 'The chain is at the hard-stop contract. Live send is unavailable; future real send would require a separate James-visible setup/activation lane.'
          : 'Next inspectable step is local review; live send is still unavailable.',
        currentStageId: currentStage?.id || null,
        currentStageLabel: currentStage?.label || 'No Mission Control send chain yet',
        currentArtifactToken: currentStage?.latestToken || null,
        currentRelativePath: currentStage?.relativePath || null,
        stageCount: stages.length,
        availableStageCount: availableStages.length,
        missingStageLabels,
        hardStopRecorded: hardStopContractRecorded,
        liveSendAvailable: false,
        realSendRequiresSeparateActivation: true,
        missionAnswerContinuity: {
          protocol: 'mira.mission_control_mission_answer_continuity.v0',
          status: missionAnswerContinuityStatus,
          originatingAnswerPreview,
          currentAnswerPreview: [...availableStages].reverse().find((stage) => stage.missionAnswerPreview)?.missionAnswerPreview || null,
          stageCount: stages.length,
          availableStageCount: availableStages.length,
          carriedStageCount: missionAnswerTrail.filter((entry) => entry.missionAnswerPreview).length,
          matchingStageCount: missionAnswerMatchingCount,
          missingStageLabels: missionAnswerMissingLabels,
          mismatchedStageLabels: missionAnswerMismatchedLabels,
          summary: missionAnswerContinuitySummary,
          stageTrail: missionAnswerTrail,
          noEffectSummary: 'Read-only Mission answer continuity proof only; it derives from existing saved Mission Control artifacts/status and does not persist, submit, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.',
        },
        demoPath: {
          protocol: 'mira.mission_control_activation_pipeline_demo_path.v0',
          surface: 'New Mira local workbench',
          open: 'Open the local New Mira workbench and read the Mission Control activation pipeline status card.',
          read: [
            'Readout',
            'Completed chain',
            'What was proven',
            'Manual-only',
            'Readout boundary',
          ],
          means: readoutStatus === 'terminal_hard_stop'
            ? 'The demo shows Mission Control can explain a complete saved local coordination chain from artifacts, ending at a hard stop instead of pretending to send.'
            : 'The demo shows the current saved Mission Control coordination chain and the next explicit manual workbench step.',
          manualOnly: 'This demo path only reads existing status/artifact evidence; it does not submit, send, execute, call a model/provider, flip routes, or access accounts/tokens.',
          nextBoundary: hardStopContractRecorded
            ? 'The chain is at the hard-stop contract. Live send is unavailable; future real send would require a separate James-visible setup/activation lane.'
            : 'Next inspectable step is local review; live send is still unavailable.',
          inspectionRunbook: {
            protocol: 'mira.mission_control_demo_inspection_runbook.v0',
            entryPoint: 'Local New Mira workbench -> Mission Control activation pipeline status card',
            evidenceSource: 'GET /mission-control/activation-pipeline-status',
            steps: [
              'Open the local New Mira workbench',
              'Find the Activation pipeline status card',
              'Read Demo path, Completed chain, What was proven, Manual-only, and Readout boundary',
              'Confirm terminal hard-stop/no-live-send truth before any future activation discussion',
            ],
            expectedReadout: hardStopContractRecorded
              ? [
                'terminal hard stop',
                `${availableStages.length}/${activationStageDefinitions.length} stages available`,
                'live send unavailable',
                'future real send requires a separate James-visible setup/activation lane',
              ]
              : [
                'in-progress local chain',
                `${availableStages.length}/${activationStageDefinitions.length} stages available`,
                'next manual workbench step remains explicit',
                'live send unavailable',
              ],
            verification: 'API and UI harnesses verify this card from the existing status GET; no screenshot, fixed-port runtime, write, or send is required for the proof.',
            boundary: 'Inspection is read-only product clarity over saved local artifacts/status; it is not a dispatch, activation, model turn, route flip, or external action.',
          },
          walkthrough: {
            protocol: 'mira.mission_control_demo_walkthrough.v0',
            title: readoutStatus === 'terminal_hard_stop'
              ? 'Mission Control completed-chain hard-stop walkthrough'
              : 'Mission Control in-progress saved-chain walkthrough',
            sourceEvidence: [
              `current stage: ${currentStage?.label || 'No saved stage'}`,
              `artifact token: ${currentStage?.latestToken || 'none'}`,
              `artifact path: ${currentStage?.relativePath || 'none'}`,
              `saved stages: ${availableStages.length}/${activationStageDefinitions.length}`,
            ],
            narrativeSteps: readoutStatus === 'terminal_hard_stop'
              ? [
                'Mission Control reads the saved local coordination chain from route preview through live-gate contract.',
                'It shows the current evidence is the live activation hard-stop contract, backed by token/path/source checksums.',
                'It explains that the chain is complete as an inspection demo, but live send is not available from this surface.',
                'It points the next boundary at a separate James-visible setup/activation lane for any future real send proposal.',
              ]
              : [
                'Mission Control reads the saved local coordination chain and identifies the current furthest artifact.',
                'It shows which local evidence backs the current stage and what manual workbench action would be next.',
                'It keeps the walkthrough read-only so the demo explains the next move without taking it.',
              ],
            whyUseful: 'This is useful because Mission Control turns saved local team-work artifacts into an inspectable next-state explanation instead of generic chat.',
            stillManual: 'The walkthrough does not click, submit, send, execute, call a provider/model, flip routes, or access accounts/tokens.',
            nextBoundary: hardStopContractRecorded
              ? 'The chain is at the hard-stop contract. Live send is unavailable; future real send would require a separate James-visible setup/activation lane.'
              : 'Next inspectable step is local review; live send is still unavailable.',
          },
          whatNowSummary: {
            protocol: 'mira.mission_control_what_now_summary.v0',
            answer: readoutStatus === 'terminal_hard_stop'
              ? 'Inspect the local status card as a completed Mission Control demo; the chain ends at a hard stop, not a live send.'
              : 'Inspect the local status card for the current saved stage and the next explicit manual workbench step.',
            currentMeaning: readoutStatus === 'terminal_hard_stop'
              ? `The saved chain is complete as a read-only demo: ${availableStages.length}/${activationStageDefinitions.length} stages are available and the current artifact is ${currentStage?.label || 'the hard stop'}.`
              : `The saved chain is in progress: ${availableStages.length}/${activationStageDefinitions.length} stages are available and the current artifact is ${currentStage?.label || 'not saved yet'}.`,
            inspectNext: readoutStatus === 'terminal_hard_stop'
              ? "Read the status card's Readout, Current evidence, Trace path, Demo walkthrough, and Hard stop rows."
              : "Read the status card's Current stage, Selected artifact, Manual action preflight, and Payload preview rows.",
            noLiveReason: 'Live action is unavailable because this status projection is read-only and any real send requires a separate James-visible setup/activation lane.',
            nextBoundary: hardStopContractRecorded
              ? 'The chain is at the hard-stop contract. Live send is unavailable; future real send would require a separate James-visible setup/activation lane.'
              : 'Next inspectable step is local review; live send is still unavailable.',
            sourceEvidence: [
              `current stage: ${currentStage?.label || 'No saved stage'}`,
              `artifact token: ${currentStage?.latestToken || 'none'}`,
              `artifact path: ${currentStage?.relativePath || 'none'}`,
              `available stages: ${availableStages.length}/${activationStageDefinitions.length}`,
              'live send available: false',
            ],
            noEffectSummary: 'What-now summary is derived from existing status/artifact evidence only; it does not persist, submit, execute, send, call a provider/model, flip routes, or access accounts/tokens.',
          },
          noEffectSummary: 'Read-only demo path only; it explains where to look in the local workbench and what the saved status means without adding a write path or live action.',
        },
        noEffectSummary: 'Read-only Mission Control end-to-end readout only; it summarizes existing status/trace artifacts and does not persist, submit, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.',
      },
      hardStopTruth: {
        liveSendAvailable: false,
        liveActivationAllowed: false,
        liveHmSendExecutionAllowed: false,
        realSendAllowed: false,
        implementationEnabled: false,
        hardStopContractRecorded,
        separateActivationLaneRequired: true,
        jamesSetupRequiredBeforeLiveSend: true,
      },
      nextBoundary: {
        label: 'Live send is not available from this surface.',
        currentNextStep: hardStopContractRecorded
          ? 'The chain is at the hard-stop contract. Live send is unavailable; future real send would require a separate James-visible setup/activation lane.'
          : 'Next inspectable step is local review; live send is still unavailable.',
        futureJamesVisibleGate: 'Future real send would require a separate James-visible setup/activation lane.',
        liveSendAvailable: false,
        separateActivationLaneRequired: true,
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
        missionAnswerPreview: request.missionAnswerPreview,
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
        missionAnswerPreview: continuation.missionAnswerPreview,
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
        missionAnswerPreview: recommendation.missionAnswerPreview,
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
        missionAnswerPreview: preview.missionAnswerPreview,
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
        missionAnswerPreview: readiness.missionAnswerPreview,
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
        missionAnswerPreview: dryRun.missionAnswerPreview,
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
        missionAnswerPreview: design.missionAnswerPreview,
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
        missionAnswerPreview: request.missionAnswerPreview,
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
        missionAnswerPreview: audit.missionAnswerPreview,
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
    if (pathname === '/mission-control/internal-send-live-activation-gate-contracts' && method === 'POST') {
      const readiness = payloads['/mission-control/internal-send-activation-implementation-readiness'].readiness
        .find((candidate) => candidate.actionToken === body?.internalSendActivationImplementationReadinessToken);
      if (!readiness) {
        return response({ ok: false, error: { message: 'Mission Control internal-send activation implementation readiness was not found.' } }, false);
      }
      const contract = {
        protocol: 'mira.mission_control_internal_send_live_activation_gate_contract.v0',
        id: 'mission-send-live-gate-test',
        actionToken: 'mission-send-live-gate-test',
        status: 'live_activation_gate_hard_stop',
        createdAt: '2026-05-21T00:00:10.000Z',
        sourceInternalSendActivationImplementationReadinessId: readiness.id,
        sourceInternalSendActivationImplementationReadinessToken: readiness.actionToken,
        sourceInternalSendActivationDecisionAuditId: readiness.sourceInternalSendActivationDecisionAuditId,
        sourceInternalSendActivationDecisionAuditToken: readiness.sourceInternalSendActivationDecisionAuditToken,
        sourceInternalSendActivationRequestId: readiness.sourceInternalSendActivationRequestId,
        sourceInternalSendActivationRequestToken: readiness.sourceInternalSendActivationRequestToken,
        sourceInternalSendActivationDesignId: readiness.sourceInternalSendActivationDesignId,
        sourceInternalSendActivationDesignToken: readiness.sourceInternalSendActivationDesignToken,
        sourceInternalSendDryRunId: readiness.sourceInternalSendDryRunId,
        sourceInternalSendDryRunToken: readiness.sourceInternalSendDryRunToken,
        sourceDispatchReadinessId: readiness.sourceDispatchReadinessId,
        sourceDispatchReadinessToken: readiness.sourceDispatchReadinessToken,
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
        content: readiness.content,
        contentPreview: readiness.contentPreview,
        missionAnswerPreview: readiness.missionAnswerPreview,
        bodySha256: readiness.bodySha256,
        adapterPacketSha256: readiness.adapterPacketSha256,
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
        jamesRequirements: [
          { id: 'james_explicit_request_required', label: 'James must explicitly request a later live internal-send activation for this exact target and body.', ok: true },
          { id: 'target_pane_confirmation_required', label: 'James-visible setup must confirm oracle pane 3 is the intended live pane target.', ok: true },
          { id: 'separate_activation_lane_required', label: 'A later activation lane must be reviewed separately before any live hm-send execution exists.', ok: true },
        ],
        setupRequirements: [
          { id: 'implementation_readiness_token_required', label: 'Missing or unknown implementation-readiness tokens must return 400 without writing.', ok: true },
          { id: 'implementation_readiness_checksum_required', label: 'Implementation-readiness body checksum must match before a live gate contract is written.', ok: true },
          { id: 'transport_dry_run_replay_required', label: 'A later activation lane must replay the dry-run envelope and compare target/body checksums before execution.', ok: true },
        ],
        rollbackRequirements: [
          { id: 'rollback_and_audit_review_required', label: 'Rollback and transport-outcome audit review must be accepted in a later lane before execution.', ok: true },
        ],
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
      payloads['/mission-control/internal-send-live-activation-gate-contracts'] = {
        ...payloads['/mission-control/internal-send-live-activation-gate-contracts'],
        contractCount: 1,
        contracts: [contract],
      };
      return response({
        ok: true,
        protocol: 'mira.mission_control_internal_send_live_activation_gate_contract_write.v0',
        created: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        relativePath: 'mission-control/internal-send-live-activation-gate-contracts/mission-send-live-gate-test.json',
        absolutePath: 'D:/projects/squidrun/mira/.state-dev/mission-control/internal-send-live-activation-gate-contracts/mission-send-live-gate-test.json',
        contract,
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
    if (pathname === '/mission-control/activation-pipeline-status' && method === 'GET') {
      return response(buildActivationPipelineStatus());
    }
    if (pathname === '/mission-control/activation-pipeline-status' && method !== 'GET') {
      return response({ ok: false, error: { message: 'method not allowed' } }, false);
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

function findButtonByText(elements, text) {
  const roots = Object.values(elements).filter(Boolean);
  const queue = [...roots];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (node.tagName === 'BUTTON' && node.textContent === text) return node;
    if (Array.isArray(node.children)) {
      queue.push(...node.children);
    }
  }
  throw new Error(`button not found: ${text}`);
}

async function clickMissionControlButton(harness, text) {
  const button = findButtonByText(harness.elements, text);
  await button.listeners.click();
  return button;
}

async function advanceMissionControlChainToHardStop(harness) {
  await harness.elements.saveRoutePreviewButton.listeners.click();
  await clickMissionControlButton(harness, 'Make review item');
  await clickMissionControlButton(harness, 'review continuation');
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
  await clickMissionControlButton(harness, 'Preview delivery packet');
  await clickMissionControlButton(harness, 'Review dispatch readiness');
  await clickMissionControlButton(harness, 'Create send dry run');
  await clickMissionControlButton(harness, 'Design activation proof');
  await clickMissionControlButton(harness, 'Preview activation request');
  await clickMissionControlButton(harness, 'Record decision audit');
  await clickMissionControlButton(harness, 'Check implementation readiness');
  await clickMissionControlButton(harness, 'Define live gate contract');
}

function extractBracedBlock(source, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }
  }
  throw new Error(`Could not extract braced block from index ${openBraceIndex}`);
}

function extractFunctionBody(source, functionName) {
  const asyncMarker = `async function ${functionName}`;
  const syncMarker = `function ${functionName}`;
  const asyncIndex = source.indexOf(asyncMarker);
  const functionIndex = asyncIndex >= 0 ? asyncIndex : source.indexOf(syncMarker);
  if (functionIndex < 0) throw new Error(`Missing function ${functionName}`);
  const paramsOpenIndex = source.indexOf('(', functionIndex);
  let paramsDepth = 0;
  let paramsCloseIndex = -1;
  for (let index = paramsOpenIndex; index < source.length; index += 1) {
    if (source[index] === '(') paramsDepth += 1;
    if (source[index] === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        paramsCloseIndex = index;
        break;
      }
    }
  }
  if (paramsCloseIndex < 0) throw new Error(`Could not find parameter list for ${functionName}`);
  let openBraceIndex = -1;
  for (let index = paramsCloseIndex + 1; index < source.length; index += 1) {
    if (source[index] !== '{') continue;
    let previous = index - 1;
    while (previous >= 0 && /\s/.test(source[previous])) previous -= 1;
    if (source[previous] !== ':') {
      openBraceIndex = index;
      break;
    }
  }
  if (openBraceIndex < 0) throw new Error(`Could not find function body for ${functionName}`);
  return extractBracedBlock(source, openBraceIndex);
}

function parseRuntimeHandlerExpectations(runtimeSource) {
  const functionBody = extractFunctionBody(runtimeSource, 'workbenchHandlerExpectationForStage');
  const cases = [];
  const casePattern = /case "([^"]+)":\s*return \{\s*handlerName: "([^"]+)",\s*handlerSource: "([^"]+)",\s*method: "([^"]+)",\s*endpoint: "([^"]+)",\s*tokenField: "([^"]+)",\s*bodyFields: \[([^\]]*)\],\s*\};/gs;
  for (const match of functionBody.matchAll(casePattern)) {
    cases.push({
      stageId: match[1],
      handlerName: match[2],
      handlerSource: match[3],
      method: match[4],
      endpoint: match[5],
      tokenField: match[6],
      bodyFields: [...match[7].matchAll(/"([^"]+)"/g)].map((fieldMatch) => fieldMatch[1]),
    });
  }
  return cases;
}

function parseWorkbenchHandlerContract(appSource, expectation) {
  const functionBody = extractFunctionBody(appSource, expectation.handlerName);
  const endpoint = functionBody.match(/fetch\('([^']+)'/)?.[1] || null;
  const method = functionBody.match(/method:\s*'([^']+)'/)?.[1] || null;
  const stringifyIndex = functionBody.indexOf('body: JSON.stringify({');
  if (stringifyIndex < 0) throw new Error(`Missing JSON.stringify body in ${expectation.handlerName}`);
  const bodyOpenBraceIndex = functionBody.indexOf('{', stringifyIndex);
  const bodyObject = extractBracedBlock(functionBody, bodyOpenBraceIndex);
  const bodyFields = [...bodyObject.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):/gm)]
    .map((match) => match[1]);
  return {
    endpoint,
    method,
    bodyFields,
  };
}

describe('Mira runtime UI boot', () => {
  test('keeps activation payload drift expectations aligned with actual workbench handler bodies', () => {
    const runtimePath = path.join(__dirname, '..', '..', 'mira', 'runtime', 'src', 'mission-control-route-preview.ts');
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const runtimeSource = fs.readFileSync(runtimePath, 'utf8');
    const appSource = fs.readFileSync(appJsPath, 'utf8');
    const expectations = parseRuntimeHandlerExpectations(runtimeSource);

    expect(expectations.map((expectation) => expectation.stageId)).toEqual([
      'route_preview',
      'internal_route_request',
      'follow_through_recommendation',
      'internal_delivery_preview',
      'dispatch_readiness',
      'internal_send_dry_run',
      'activation_design',
      'activation_request',
      'activation_decision_audit',
      'activation_implementation_readiness',
    ]);

    expectations.forEach((expectation) => {
      const handlerContract = parseWorkbenchHandlerContract(appSource, expectation);
      expect(expectation.handlerSource).toBe(`mira/ui/app.js:${expectation.handlerName}`);
      expect(handlerContract).toEqual({
        endpoint: expectation.endpoint,
        method: expectation.method,
        bodyFields: expectation.bodyFields,
      });
      expect(handlerContract.bodyFields).toContain(expectation.tokenField);
    });
  });

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
      expect.objectContaining({ url: '/mission-control/internal-send-live-activation-gate-contracts', method: 'GET' }),
      expect.objectContaining({ url: '/mission-control/activation-pipeline-status', method: 'GET' }),
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
    expect(harness.elements.routeInternalSendLiveGateList.textContent).toBe('no live activation gate contracts yet');
    const emptyPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const emptyStepHeader = emptyPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(emptyStepHeader.textContent).toBe('Next manual step: none ready. Read-only status card only; no manual action is selected.');
    expect(emptyStepHeader.children).toHaveLength(0);
    const emptyPipelineText = emptyPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(emptyPipelineText).toContain('Activation pipeline status');
    expect(emptyPipelineText).toContain('No chain yet · read only · not sent');
    expect(emptyPipelineText).toContain('Current stage: No saved Mission Control send chain yet.');
    expect(emptyPipelineText).toContain('Hard stop: live send available: no; hard-stop contract: no; James setup before live send: yes');
    expect(emptyPipelineText).toContain('Future real send would require a separate James-visible setup/activation lane.');
    expect(emptyPipelineText).toContain('Trace path: No saved Mission Control activation artifacts yet.');
    expect(emptyPipelineText).toContain('Current evidence: No saved artifact backs this chain yet.');
    expect(emptyPipelineText).toContain('Advance selector: no chain: No saved artifact -> Route preview. No saved Mission Control route preview exists yet, so there is no artifact to advance.');
    expect(emptyPipelineText).toContain('Selected artifact: No saved artifact is available to advance.');
    expect(emptyPipelineText).toContain('Comparison: Compared 0 available stages; start by saving a route preview.');
    expect(emptyPipelineText).toContain('Manual action preflight: blocked no source: no manual action · No manual action is ready because there is no selected saved artifact with a token and next missing stage.');
    expect(emptyPipelineText).toContain('Manual action input: No manual action input is ready.');
    expect(emptyPipelineText).toContain('Workbench focus: No manual workbench step is ready to highlight.');
    expect(emptyPipelineText).toContain('Manual selector summary: blocked: no existing manual action is ready to select.');
    expect(emptyPipelineText).toContain('Manual-only checklist: ok: status surface is read-only / blocked: manual preflight ready (blocked_no_source) / blocked: highlighted source available (no) / blocked: payload matches handler (blocked) / ok: selector summary does not submit anything');
    expect(emptyPipelineText).toContain('Payload preview: blocked: no method no endpoint · No payload preview is available because the manual action preflight is blocked.');
    expect(emptyPipelineText).toContain('Payload body: No payload body is available.');
    expect(emptyPipelineText).toContain('Payload validation: blocked: Manual action preflight is ready. / blocked: Existing workbench endpoint is known. / blocked: Selected artifact token is present in the preview payload. / ok: Payload preview is derived from GET status and is not submitted or persisted.');
    expect(emptyPipelineText).toContain('Handler drift check: blocked: no handler · No workbench handler drift check is available because the manual action preflight is blocked.');
    expect(emptyPipelineText).toContain('Handler contract: no method no endpoint; token no token; body none');
    expect(emptyPipelineText).toContain('Handler checks: blocked: Manual action preflight is ready. / blocked: Workbench handler method matches the payload preview method. / blocked: Workbench handler endpoint matches the payload preview endpoint.');
    expect(emptyPipelineText).toContain('Trace audit: Read-only trace only; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery.');
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
    expect(harness.elements.workSummary.textContent).toContain('0 live gates');
    expect(harness.elements.workSummary.textContent).toContain('12 pipeline stages');
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
    expect(harness.calls.filter((call) => call.url === '/mission-control/activation-pipeline-status')).toEqual([
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
    expect(historyText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(historyText).toContain('no runtime execution, external send, route flip, provider, account or token access, or live hm-send');
    expect(historyText).toContain('Mission Control focus: selected source for Make review item; use the existing Make review item action.');
    expect(harness.elements.routePreviewHistoryList.children[0].className).toContain('selected-manual-source');
    expect(harness.elements.routePreviewHistoryList.children[0].attributes.id).toBe('mission-control-manual-step-route-preview-mission-route-test');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Route preview saved for internal review. Nothing was sent or executed.');
    expect(harness.elements.saveRoutePreviewButton.disabled).toBe(false);
    expect(harness.elements.saveRoutePreviewButton.textContent).toBe('Save preview for review');
    const routePreviewPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const routePreviewStepHeader = routePreviewPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(routePreviewStepHeader.textContent).toBe('Next manual step: Make review item on Route preview. Manual-only. Use the existing highlighted card/button; this status card does not submit.');
    expect(routePreviewStepHeader.children).toHaveLength(1);
    expect(routePreviewStepHeader.children[0].tagName).toBe('A');
    expect(routePreviewStepHeader.children[0].textContent).toBe('Jump to highlighted Route preview card');
    expect(routePreviewStepHeader.children[0].attributes.href).toBe('#mission-control-manual-step-route-preview-mission-route-test');
    expect(routePreviewStepHeader.children[0].attributes['aria-label']).toBe('Jump to highlighted Route preview card');
    const routePreviewPipelineText = routePreviewPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(routePreviewPipelineText).toContain('Advance selector: advance available: Route preview -> Review item. Route preview is the latest available stage before the first missing stage, Review item.');
    expect(routePreviewPipelineText).toContain('Selected artifact: token mission-route-test; path mission-control/route-previews/mission-route-preview-test.json; source not available; body not available; adapter not available');
    expect(routePreviewPipelineText).toContain('Comparison: Compared 1 available stage(s); selected Route preview because Review item is the first missing stage.');
    expect(routePreviewPipelineText).toContain('Manual action preflight: ready: Make review item · Make review item is the next manual internal action because Route preview is selected and Review item is the first missing stage. Use the selected token as previewToken; this preflight does not perform the action.');
    expect(routePreviewPipelineText).toContain('Manual action input: previewToken=mission-route-test; source mission-control/route-previews/mission-route-preview-test.json; next Review item');
    expect(routePreviewPipelineText).toContain('Workbench focus: Highlight the existing Route preview card at mission-control/route-previews/mission-route-preview-test.json and use its existing Make review item action.');
    expect(routePreviewPipelineText).toContain('Manual selector summary: ready: Make review item on Route preview; previewToken=mission-route-test; POST /mission-control/internal-route-requests; manual-only because this status card does not submit.');
    expect(routePreviewPipelineText).toContain('Manual-only checklist: ok: status surface is read-only / ok: highlighted source is an existing workbench card / ok: payload preview matches existing handler / ok: use the existing highlighted button manually / ok: selector summary does not submit anything');
    expect(routePreviewPipelineText).toContain('Preflight checks: ok: Selected artifact token is available. / ok: Selected artifact path is available or the selected entry is derived. / ok: A next missing stage exists for manual advancement.');
    expect(routePreviewPipelineText).toContain('Payload preview: ready: POST /mission-control/internal-route-requests · This is the exact workbench payload preview for Make review item; it is not submitted by the status surface.');
    expect(routePreviewPipelineText).toContain('Payload body: {"previewToken":"mission-route-test"}');
    expect(routePreviewPipelineText).toContain('Payload validation: ok: Manual action preflight is ready. / ok: Existing workbench endpoint is known. / ok: Selected artifact token is present in the preview payload. / ok: Payload preview is derived from GET status and is not submitted or persisted.');
    expect(routePreviewPipelineText).toContain('Handler drift check: matched: createRouteRequestFromPreview · createRouteRequestFromPreview expects POST /mission-control/internal-route-requests with previewToken; payload preview matches that workbench handler contract.');
    expect(routePreviewPipelineText).toContain('Handler contract: POST /mission-control/internal-route-requests; token previewToken; body previewToken');
    expect(routePreviewPipelineText).toContain('Handler checks: ok: Manual action preflight is ready. / ok: Workbench handler method matches the payload preview method. / ok: Workbench handler endpoint matches the payload preview endpoint. / ok: Workbench handler token field matches the payload preview token field.');
    expect(appJs).toContain('async function createRouteRequestFromPreview(preview)');
    expect(appJs).toContain("fetch('/mission-control/internal-route-requests'");
    expect(appJs).toContain("previewToken: preview?.actionToken || ''");

    const promoteButton = harness.elements.routePreviewHistoryList.children[0].children
      .find((child) => child.tagName === 'BUTTON');
    expect(promoteButton.textContent).toBe('Make review item');
    expect(promoteButton.className).toContain('selected-manual-action');
    expect(promoteButton.attributes['aria-label']).toBe('Selected Mission Control action: Make review item');
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
    expect(harness.elements.routePreviewHistoryList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routePreviewHistoryList.children[0].attributes.id || '').toBe('');
    expect(harness.elements.routeRequestList.children).toHaveLength(1);
    expect(harness.elements.routeRequestList.children[0].className).toContain('selected-manual-source');
    expect(harness.elements.routeRequestList.children[0].attributes.id).toBe('mission-control-manual-step-internal-route-request-mission-request-test');
    const requestActionButton = harness.elements.routeRequestList.children[0].children
      .find((child) => child.tagName === 'BUTTON');
    expect(requestActionButton.textContent).toBe('review continuation');
    expect(requestActionButton.className).toContain('selected-manual-action');
    expect(requestActionButton.attributes['aria-label']).toBe('Selected Mission Control action: Review continuation');
    const postPromotePipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const postPromoteStepHeader = postPromotePipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(postPromoteStepHeader.textContent).toBe('Next manual step: none ready. Read-only status card only; no manual action is selected.');
    expect(postPromoteStepHeader.children).toHaveLength(0);
    const postPromotePipelineText = postPromotePipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(postPromotePipelineText).toContain('Current stage: Review item: pending internal review; token mission-request-test.');
    expect(postPromotePipelineText).toContain('Current evidence: token mission-request-test; status saved; path mission-control/internal-route-requests/mission-route-request-test.json; relation route_preview -> internal_route_request; source token mission-route-test; no checksum recorded');
    expect(postPromotePipelineText).toContain('Advance selector: advance available: Review item -> Owned-work continuation. Review item is the latest available stage before the first missing stage, Owned-work continuation.');
    expect(postPromotePipelineText).toContain('Manual action preflight: ready: Review continuation · Review continuation is the next manual internal action because Review item is selected and Owned-work continuation is the first missing stage. Use the selected token as requestToken; this preflight does not perform the action.');
    expect(postPromotePipelineText).toContain('Manual action input: requestToken=mission-request-test; source mission-control/internal-route-requests/mission-route-request-test.json; next Owned-work continuation');
    expect(postPromotePipelineText).toContain('Workbench focus: Highlight the existing Review item card at mission-control/internal-route-requests/mission-route-request-test.json and use its existing Review continuation action.');
    expect(postPromotePipelineText).toContain('Manual selector summary: blocked: no existing manual action is ready to select.');
    expect(postPromotePipelineText).toContain('Manual-only checklist: ok: status surface is read-only / blocked: manual preflight ready (ready) / blocked: highlighted source available (yes) / blocked: payload matches handler (matched) / ok: selector summary does not submit anything');
    expect(postPromotePipelineText).toContain('Payload preview: needs manual input: POST /mission-control/owned-work-continuations · This payload skeleton needs manual input before Review continuation can be submitted from the workbench.');
    expect(postPromotePipelineText).toContain('Payload body: {"requestToken":"mission-request-test","decision":"<approve|edit|reject>","editedContent":"<review text when editing>","note":"<optional note>"}');
    expect(postPromotePipelineText).toContain('Handler drift check: matched: createOwnedWorkContinuation · createOwnedWorkContinuation expects POST /mission-control/owned-work-continuations with requestToken; payload preview matches that workbench handler contract.');
    expect(harness.calls.some((call) => call.url === '/bridge/manual-plan')).toBe(false);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.routeRequestList.children).toHaveLength(1);
    const requestText = harness.elements.routeRequestList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(requestText).toContain('oracle · benchmark review review item');
    expect(requestText).toContain('pending internal review · manual execution required · not sent');
    expect(requestText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(requestText).toContain('no command stored, runtime execution, external send, route flip, provider, account or token access, or live hm-send');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Route review item saved locally. Nothing was sent or executed.');

    const reviewButton = harness.elements.routeRequestList.children[0].children
      .find((child) => child.tagName === 'BUTTON');
    expect(reviewButton.textContent).toBe('review continuation');
    reviewButton.listeners.click();
    expect(harness.elements.routeContinuationPanel.children[0].textContent).toBe('oracle · benchmark review continuation');
    const continuationPanelText = harness.elements.routeContinuationPanel.children
      .map((child) => child.textContent)
      .join('\n');
    expect(continuationPanelText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
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
    expect(continuationText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(continuationText).toContain('no command stored, runtime execution, external send, route flip, provider, account or token access, or live hm-send');
    expect(harness.elements.routeFollowThroughList.children).toHaveLength(1);
    const followThroughText = harness.elements.routeFollowThroughList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(followThroughText).toContain('Selected next internal move: oracle');
    expect(followThroughText).toContain('review-only selector · manual execution required · not sent');
    expect(followThroughText).toContain('Next move: Ask oracle to review the edit benchmark review continuation: Edited internal continuation for Oracle review.');
    expect(followThroughText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(followThroughText).toContain('Source continuation: edit · edited for internal review');
    expect(followThroughText).toContain('no command stored, runtime execution, external send, route flip, provider, account or token access, Telegram, or live hm-send');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('edit continuation metadata saved locally. Nothing was sent or executed.');
    expect(harness.elements.routeRequestList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routeRequestList.children[0].attributes.id || '').toBe('');
    expect(harness.elements.routeFollowThroughList.children[0].className).toContain('selected-manual-source');
    expect(harness.elements.routeFollowThroughList.children[0].attributes.id).toBe('mission-control-manual-step-follow-through-recommendation-mission-follow-through-test');

    const deliveryButton = harness.elements.routeFollowThroughList.children[0].children
      .find((child) => child.tagName === 'BUTTON');
    expect(deliveryButton.textContent).toBe('Preview delivery packet');
    expect(deliveryButton.className).toContain('selected-manual-action');
    expect(deliveryButton.attributes['aria-label']).toBe('Selected Mission Control action: Preview delivery packet');
    const postContinuationPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const postContinuationStepHeader = postContinuationPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(postContinuationStepHeader.textContent).toBe('Next manual step: Preview delivery packet on Follow-through recommendation. Manual-only. Use the existing highlighted card/button; this status card does not submit.');
    expect(postContinuationStepHeader.children).toHaveLength(1);
    expect(postContinuationStepHeader.children[0].attributes.href).toBe('#mission-control-manual-step-follow-through-recommendation-mission-follow-through-test');
    const postContinuationPipelineText = postContinuationPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(postContinuationPipelineText).toContain('Current stage: Follow-through recommendation: selected for internal review; token mission-follow-through-test.');
    expect(postContinuationPipelineText).toContain('Last saved: Owned-work continuation: edited_for_internal_review; token mission-continuation-test');
    expect(postContinuationPipelineText).toContain('Current evidence: token mission-follow-through-test; status derived; path not available; relation owned_work_continuation -> follow_through_recommendation; source token mission-continuation-test; no checksum recorded');
    expect(postContinuationPipelineText).toContain('Advance selector: advance available: Follow-through recommendation -> Delivery preview. Follow-through recommendation is the latest available stage before the first missing stage, Delivery preview.');
    expect(postContinuationPipelineText).toContain('Manual action preflight: ready: Preview delivery packet · Preview delivery packet is the next manual internal action because Follow-through recommendation is selected and Delivery preview is the first missing stage. Use the selected token as recommendationToken; this preflight does not perform the action.');
    expect(postContinuationPipelineText).toContain('Manual action input: recommendationToken=mission-follow-through-test; source not available; next Delivery preview');
    expect(postContinuationPipelineText).toContain('Workbench focus: Highlight the existing Follow-through recommendation card at unknown path and use its existing Preview delivery packet action.');
    expect(postContinuationPipelineText).toContain('Manual selector summary: ready: Preview delivery packet on Follow-through recommendation; recommendationToken=mission-follow-through-test; POST /mission-control/internal-delivery-previews; manual-only because this status card does not submit.');
    expect(postContinuationPipelineText).toContain('Payload preview: ready: POST /mission-control/internal-delivery-previews · This is the exact workbench payload preview for Preview delivery packet; it is not submitted by the status surface.');
    expect(postContinuationPipelineText).toContain('Payload body: {"recommendationToken":"mission-follow-through-test"}');
    expect(postContinuationPipelineText).toContain('Handler drift check: matched: createInternalDeliveryPreview · createInternalDeliveryPreview expects POST /mission-control/internal-delivery-previews with recommendationToken; payload preview matches that workbench handler contract.');
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
    expect(deliveryText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(deliveryText).toContain('Checksum: packet-sha256-test');
    expect(deliveryText).toContain('Review: Manual copy only: paste this body into oracle pane 3 after review.');
    expect(deliveryText).toContain('no command stored, runtime execution, external send, route flip, provider/model call, account or token access, Telegram, or live hm-send');
    expect(harness.elements.routeFollowThroughList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routeFollowThroughList.children[0].attributes.id || '').toBe('');
    expect(harness.elements.routeDeliveryPreviewList.children[0].className).toContain('selected-manual-source');
    expect(harness.elements.routeDeliveryPreviewList.children[0].attributes.id).toBe('mission-control-manual-step-internal-delivery-preview-mission-delivery-preview-test');
    const copyButton = harness.elements.routeDeliveryPreviewList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Copy packet body');
    expect(copyButton.textContent).toBe('Copy packet body');
    await copyButton.listeners.click();
    expect(harness.context.navigator.clipboard.writeText).toHaveBeenCalledWith('Edited internal continuation for Oracle review.');
    expect(copyButton.textContent).toBe('Copied body');
    const readinessButton = harness.elements.routeDeliveryPreviewList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Review dispatch readiness');
    expect(readinessButton.textContent).toBe('Review dispatch readiness');
    expect(readinessButton.className).toContain('selected-manual-action');
    expect(readinessButton.attributes['aria-label']).toBe('Selected Mission Control action: Review dispatch readiness');
    const postDeliveryPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const postDeliveryStepHeader = postDeliveryPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(postDeliveryStepHeader.textContent).toBe('Next manual step: Review dispatch readiness on Delivery preview. Manual-only. Use the existing highlighted card/button; this status card does not submit.');
    expect(postDeliveryStepHeader.children).toHaveLength(1);
    expect(postDeliveryStepHeader.children[0].attributes.href).toBe('#mission-control-manual-step-internal-delivery-preview-mission-delivery-preview-test');
    const postDeliveryPipelineText = postDeliveryPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(postDeliveryPipelineText).toContain('Current stage: Delivery preview: reviewed preview only; token mission-delivery-preview-test.');
    expect(postDeliveryPipelineText).toContain('Last saved: Delivery preview: reviewed_preview_only; token mission-delivery-preview-test');
    expect(postDeliveryPipelineText).toContain('Current evidence: token mission-delivery-preview-test; status saved; path mission-control/internal-delivery-previews/mission-delivery-preview-test.json; relation follow_through_recommendation -> internal_delivery_preview; source token mission-follow-through-test; no checksum recorded');
    expect(postDeliveryPipelineText).toContain('Advance selector: advance available: Delivery preview -> Dispatch readiness. Delivery preview is the latest available stage before the first missing stage, Dispatch readiness.');
    expect(postDeliveryPipelineText).toContain('Manual action preflight: ready: Review dispatch readiness · Review dispatch readiness is the next manual internal action because Delivery preview is selected and Dispatch readiness is the first missing stage. Use the selected token as deliveryPreviewToken; this preflight does not perform the action.');
    expect(postDeliveryPipelineText).toContain('Manual action input: deliveryPreviewToken=mission-delivery-preview-test; source mission-control/internal-delivery-previews/mission-delivery-preview-test.json; next Dispatch readiness');
    expect(postDeliveryPipelineText).toContain('Selected artifact: token mission-delivery-preview-test; path mission-control/internal-delivery-previews/mission-delivery-preview-test.json; source mission-follow-through-test; body not available; adapter not available');
    expect(postDeliveryPipelineText).toContain('Workbench focus: Highlight the existing Delivery preview card at mission-control/internal-delivery-previews/mission-delivery-preview-test.json and use its existing Review dispatch readiness action.');
    expect(postDeliveryPipelineText).toContain('Manual selector summary: ready: Review dispatch readiness on Delivery preview; deliveryPreviewToken=mission-delivery-preview-test; POST /mission-control/dispatch-readiness; manual-only because this status card does not submit.');
    expect(postDeliveryPipelineText).toContain('Payload preview: ready: POST /mission-control/dispatch-readiness · This is the exact workbench payload preview for Review dispatch readiness; it is not submitted by the status surface.');
    expect(postDeliveryPipelineText).toContain('Payload body: {"deliveryPreviewToken":"mission-delivery-preview-test"}');
    expect(postDeliveryPipelineText).toContain('Handler drift check: matched: createDispatchReadiness · createDispatchReadiness expects POST /mission-control/dispatch-readiness with deliveryPreviewToken; payload preview matches that workbench handler contract.');
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
    expect(readinessText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(readinessText).toContain('Body checksum: body-sha256-test');
    expect(readinessText).toContain('Packet checksum: packet-sha256-test');
    expect(readinessText).toContain('Checksum match: yes');
    expect(readinessText).toContain('Copied pane body checksum matches the saved delivery preview body.');
    expect(readinessText).toContain('no command stored, hm-send execution, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    expect(harness.elements.routeDeliveryPreviewList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routeDeliveryPreviewList.children[0].attributes.id || '').toBe('');
    expect(harness.elements.routeDispatchReadinessList.children[0].className).toContain('selected-manual-source');
    expect(harness.elements.routeDispatchReadinessList.children[0].attributes.id).toBe('mission-control-manual-step-dispatch-readiness-mission-dispatch-readiness-test');
    const dryRunButton = harness.elements.routeDispatchReadinessList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Create send dry run');
    expect(dryRunButton.textContent).toBe('Create send dry run');
    expect(dryRunButton.className).toContain('selected-manual-action');
    expect(dryRunButton.attributes['aria-label']).toBe('Selected Mission Control action: Create send dry run');
    const postDispatchPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const postDispatchStepHeader = postDispatchPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(postDispatchStepHeader.textContent).toBe('Next manual step: Create send dry run on Dispatch readiness. Manual-only. Use the existing highlighted card/button; this status card does not submit.');
    expect(postDispatchStepHeader.children).toHaveLength(1);
    expect(postDispatchStepHeader.children[0].attributes.href).toBe('#mission-control-manual-step-dispatch-readiness-mission-dispatch-readiness-test');
    const postDispatchPipelineText = postDispatchPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(postDispatchPipelineText).toContain('Current stage: Dispatch readiness: ready for manual dispatch review; token mission-dispatch-readiness-test.');
    expect(postDispatchPipelineText).toContain('Last saved: Dispatch readiness: ready_for_manual_dispatch_review; token mission-dispatch-readiness-test');
    expect(postDispatchPipelineText).toContain('Current evidence: token mission-dispatch-readiness-test; status saved; path mission-control/dispatch-readiness/mission-dispatch-readiness-test.json; relation internal_delivery_preview -> dispatch_readiness; source token mission-delivery-preview-test; body body-sha256-test');
    expect(postDispatchPipelineText).toContain('Advance selector: advance available: Dispatch readiness -> Internal-send dry run. Dispatch readiness is the latest available stage before the first missing stage, Internal-send dry run.');
    expect(postDispatchPipelineText).toContain('Manual action preflight: ready: Create send dry run · Create send dry run is the next manual internal action because Dispatch readiness is selected and Internal-send dry run is the first missing stage. Use the selected token as dispatchReadinessToken; this preflight does not perform the action.');
    expect(postDispatchPipelineText).toContain('Manual action input: dispatchReadinessToken=mission-dispatch-readiness-test; source mission-control/dispatch-readiness/mission-dispatch-readiness-test.json; next Internal-send dry run');
    expect(postDispatchPipelineText).toContain('Selected artifact: token mission-dispatch-readiness-test; path mission-control/dispatch-readiness/mission-dispatch-readiness-test.json; source mission-delivery-preview-test; body body-sha256-test; adapter not available');
    expect(postDispatchPipelineText).toContain('Workbench focus: Highlight the existing Dispatch readiness card at mission-control/dispatch-readiness/mission-dispatch-readiness-test.json and use its existing Create send dry run action.');
    expect(postDispatchPipelineText).toContain('Manual selector summary: ready: Create send dry run on Dispatch readiness; dispatchReadinessToken=mission-dispatch-readiness-test; POST /mission-control/internal-send-dry-runs; manual-only because this status card does not submit.');
    expect(postDispatchPipelineText).toContain('Payload preview: ready: POST /mission-control/internal-send-dry-runs · This is the exact workbench payload preview for Create send dry run; it is not submitted by the status surface.');
    expect(postDispatchPipelineText).toContain('Payload body: {"dispatchReadinessToken":"mission-dispatch-readiness-test"}');
    expect(postDispatchPipelineText).toContain('Handler drift check: matched: createInternalSendDryRun · createInternalSendDryRun expects POST /mission-control/internal-send-dry-runs with dispatchReadinessToken; payload preview matches that workbench handler contract.');
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
    expect(dryRunText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(dryRunText).toContain('Adapter: hm-send dry-run via ui/scripts/hm-send.js');
    expect(dryRunText).toContain('Activation gate: separate_reviewed_activation');
    expect(dryRunText).toContain('no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    expect(harness.elements.routeDispatchReadinessList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routeDispatchReadinessList.children[0].attributes.id || '').toBe('');
    expect(harness.elements.routeInternalSendDryRunList.children[0].className).toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendDryRunList.children[0].attributes.id).toBe('mission-control-manual-step-internal-send-dry-run-mission-send-dry-run-test');
    const activationDesignButton = harness.elements.routeInternalSendDryRunList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Design activation proof');
    expect(activationDesignButton.textContent).toBe('Design activation proof');
    expect(activationDesignButton.className).toContain('selected-manual-action');
    expect(activationDesignButton.attributes['aria-label']).toBe('Selected Mission Control action: Design activation proof');
    const postDryRunPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const postDryRunStepHeader = postDryRunPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(postDryRunStepHeader.textContent).toBe('Next manual step: Design activation proof on Internal-send dry run. Manual-only. Use the existing highlighted card/button; this status card does not submit.');
    expect(postDryRunStepHeader.children).toHaveLength(1);
    expect(postDryRunStepHeader.children[0].attributes.href).toBe('#mission-control-manual-step-internal-send-dry-run-mission-send-dry-run-test');
    const postDryRunPipelineText = postDryRunPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(postDryRunPipelineText).toContain('Current stage: Internal-send dry run: dry run ready; token mission-send-dry-run-test.');
    expect(postDryRunPipelineText).toContain('Last saved: Internal-send dry run: dry_run_ready; token mission-send-dry-run-test');
    expect(postDryRunPipelineText).toContain('Current evidence: token mission-send-dry-run-test; status saved; path mission-control/internal-send-dry-runs/mission-send-dry-run-test.json; relation dispatch_readiness -> internal_send_dry_run; source token mission-dispatch-readiness-test; body body-sha256-test');
    expect(postDryRunPipelineText).toContain('Advance selector: advance available: Internal-send dry run -> Activation design. Internal-send dry run is the latest available stage before the first missing stage, Activation design.');
    expect(postDryRunPipelineText).toContain('Manual action preflight: ready: Design activation proof · Design activation proof is the next manual internal action because Internal-send dry run is selected and Activation design is the first missing stage. Use the selected token as internalSendDryRunToken; this preflight does not perform the action.');
    expect(postDryRunPipelineText).toContain('Manual action input: internalSendDryRunToken=mission-send-dry-run-test; source mission-control/internal-send-dry-runs/mission-send-dry-run-test.json; next Activation design');
    expect(postDryRunPipelineText).toContain('Selected artifact: token mission-send-dry-run-test; path mission-control/internal-send-dry-runs/mission-send-dry-run-test.json; source mission-dispatch-readiness-test; body body-sha256-test; adapter not available');
    expect(postDryRunPipelineText).toContain('Workbench focus: Highlight the existing Internal-send dry run card at mission-control/internal-send-dry-runs/mission-send-dry-run-test.json and use its existing Design activation proof action.');
    expect(postDryRunPipelineText).toContain('Manual selector summary: ready: Design activation proof on Internal-send dry run; internalSendDryRunToken=mission-send-dry-run-test; POST /mission-control/internal-send-activation-designs; manual-only because this status card does not submit.');
    expect(postDryRunPipelineText).toContain('Payload preview: ready: POST /mission-control/internal-send-activation-designs · This is the exact workbench payload preview for Design activation proof; it is not submitted by the status surface.');
    expect(postDryRunPipelineText).toContain('Payload body: {"internalSendDryRunToken":"mission-send-dry-run-test"}');
    expect(postDryRunPipelineText).toContain('Handler drift check: matched: createInternalSendActivationDesign · createInternalSendActivationDesign expects POST /mission-control/internal-send-activation-designs with internalSendDryRunToken; payload preview matches that workbench handler contract.');
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
    expect(activationDesignText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(activationDesignText).toContain('Activation gate: separate_reviewed_activation; activation allowed: no');
    expect(activationDesignText).toContain('Missing or unknown internal-send dry-run tokens must return 400 without writing.');
    expect(activationDesignText).toContain('Future activation must snapshot the dry-run token, target, body checksum, and adapter checksum before any execution.');
    expect(activationDesignText).toContain('design/proof only; durable audit, refusal, and rollback requirements are visible; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    expect(harness.elements.routeInternalSendDryRunList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendDryRunList.children[0].attributes.id || '').toBe('');
    expect(harness.elements.routeInternalSendActivationDesignList.children[0].className).toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendActivationDesignList.children[0].attributes.id).toBe('mission-control-manual-step-activation-design-mission-send-activation-design-test');
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
    expect(activationRequestButton.className).toContain('selected-manual-action');
    expect(activationRequestButton.attributes['aria-label']).toBe('Selected Mission Control action: Preview activation request');
    const postActivationDesignPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const postActivationDesignStepHeader = postActivationDesignPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(postActivationDesignStepHeader.textContent).toBe('Next manual step: Preview activation request on Activation design. Manual-only. Use the existing highlighted card/button; this status card does not submit.');
    expect(postActivationDesignStepHeader.children).toHaveLength(1);
    expect(postActivationDesignStepHeader.children[0].attributes.href).toBe('#mission-control-manual-step-activation-design-mission-send-activation-design-test');
    const postActivationDesignPipelineText = postActivationDesignPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(postActivationDesignPipelineText).toContain('Current stage: Activation design: activation design review only; token mission-send-activation-design-test.');
    expect(postActivationDesignPipelineText).toContain('Last saved: Activation design: activation_design_review_only; token mission-send-activation-design-test');
    expect(postActivationDesignPipelineText).toContain('Current evidence: token mission-send-activation-design-test; status saved; path mission-control/internal-send-activation-designs/mission-send-activation-design-test.json; relation internal_send_dry_run -> activation_design; source token mission-send-dry-run-test; body body-sha256-test; adapter adapter-packet-sha256');
    expect(postActivationDesignPipelineText).toContain('Advance selector: advance available: Activation design -> Activation request. Activation design is the latest available stage before the first missing stage, Activation request.');
    expect(postActivationDesignPipelineText).toContain('Manual action preflight: ready: Preview activation request · Preview activation request is the next manual internal action because Activation design is selected and Activation request is the first missing stage. Use the selected token as internalSendActivationDesignToken; this preflight does not perform the action.');
    expect(postActivationDesignPipelineText).toContain('Manual action input: internalSendActivationDesignToken=mission-send-activation-design-test; source mission-control/internal-send-activation-designs/mission-send-activation-design-test.json; next Activation request');
    expect(postActivationDesignPipelineText).toContain('Selected artifact: token mission-send-activation-design-test; path mission-control/internal-send-activation-designs/mission-send-activation-design-test.json; source mission-send-dry-run-test; body body-sha256-test; adapter adapter-packet-sha256');
    expect(postActivationDesignPipelineText).toContain('Workbench focus: Highlight the existing Activation design card at mission-control/internal-send-activation-designs/mission-send-activation-design-test.json and use its existing Preview activation request action.');
    expect(postActivationDesignPipelineText).toContain('Manual selector summary: ready: Preview activation request on Activation design; internalSendActivationDesignToken=mission-send-activation-design-test; POST /mission-control/internal-send-activation-requests; manual-only because this status card does not submit.');
    expect(postActivationDesignPipelineText).toContain('Payload preview: ready: POST /mission-control/internal-send-activation-requests · This is the exact workbench payload preview for Preview activation request; it is not submitted by the status surface.');
    expect(postActivationDesignPipelineText).toContain('Payload body: {"internalSendActivationDesignToken":"mission-send-activation-design-test"}');
    expect(postActivationDesignPipelineText).toContain('Handler drift check: matched: createInternalSendActivationRequest · createInternalSendActivationRequest expects POST /mission-control/internal-send-activation-requests with internalSendActivationDesignToken; payload preview matches that workbench handler contract.');
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
    expect(activationRequestText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(activationRequestText).toContain('Reviewer: architect_or_oracle · pending review');
    expect(activationRequestText).toContain('Activation request: separate_reviewed_activation; activation allowed: no');
    expect(activationRequestText).toContain('Missing or unknown activation-design tokens must return 400 without writing.');
    expect(activationRequestText).toContain('A later activation must define rollback/failure handling before execution is allowed.');
    expect(activationRequestText).toContain('request preview only; reviewer, refusal, rollback, and audit fields are visible; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    expect(harness.elements.routeInternalSendActivationDesignList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendActivationDesignList.children[0].attributes.id || '').toBe('');
    expect(harness.elements.routeInternalSendActivationRequestList.children[0].className).toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendActivationRequestList.children[0].attributes.id).toBe('mission-control-manual-step-activation-request-mission-send-activation-request-test');
    const activationAuditCallsBeforeClick = harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-decision-audits');
    expect(activationAuditCallsBeforeClick.every((call) => call.method === 'GET')).toBe(true);
    expect(activationAuditCallsBeforeClick).toHaveLength(9);
    const activationAuditButton = harness.elements.routeInternalSendActivationRequestList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Record decision audit');
    expect(activationAuditButton.textContent).toBe('Record decision audit');
    expect(activationAuditButton.className).toContain('selected-manual-action');
    expect(activationAuditButton.attributes['aria-label']).toBe('Selected Mission Control action: Record decision audit');
    const postActivationRequestPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const postActivationRequestStepHeader = postActivationRequestPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(postActivationRequestStepHeader.textContent).toBe('Next manual step: Record decision audit on Activation request. Manual-only. Use the existing highlighted card/button; this status card does not submit.');
    expect(postActivationRequestStepHeader.children).toHaveLength(1);
    expect(postActivationRequestStepHeader.children[0].attributes.href).toBe('#mission-control-manual-step-activation-request-mission-send-activation-request-test');
    const postActivationRequestPipelineText = postActivationRequestPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(postActivationRequestPipelineText).toContain('Current stage: Activation request: activation request review only; token mission-send-activation-request-test.');
    expect(postActivationRequestPipelineText).toContain('Last saved: Activation request: activation_request_review_only; token mission-send-activation-request-test');
    expect(postActivationRequestPipelineText).toContain('Current evidence: token mission-send-activation-request-test; status saved; path mission-control/internal-send-activation-requests/mission-send-activation-request-test.json; relation activation_design -> activation_request; source token mission-send-activation-design-test; body body-sha256-test; adapter adapter-packet-sha256');
    expect(postActivationRequestPipelineText).toContain('Advance selector: advance available: Activation request -> Decision audit. Activation request is the latest available stage before the first missing stage, Decision audit.');
    expect(postActivationRequestPipelineText).toContain('Manual action preflight: ready: Record decision audit · Record decision audit is the next manual internal action because Activation request is selected and Decision audit is the first missing stage. Use the selected token as internalSendActivationRequestToken; this preflight does not perform the action.');
    expect(postActivationRequestPipelineText).toContain('Manual action input: internalSendActivationRequestToken=mission-send-activation-request-test; source mission-control/internal-send-activation-requests/mission-send-activation-request-test.json; next Decision audit');
    expect(postActivationRequestPipelineText).toContain('Selected artifact: token mission-send-activation-request-test; path mission-control/internal-send-activation-requests/mission-send-activation-request-test.json; source mission-send-activation-design-test; body body-sha256-test; adapter adapter-packet-sha256');
    expect(postActivationRequestPipelineText).toContain('Workbench focus: Highlight the existing Activation request card at mission-control/internal-send-activation-requests/mission-send-activation-request-test.json and use its existing Record decision audit action.');
    expect(postActivationRequestPipelineText).toContain('Manual selector summary: ready: Record decision audit on Activation request; internalSendActivationRequestToken=mission-send-activation-request-test; POST /mission-control/internal-send-activation-decision-audits; manual-only because this status card does not submit.');
    expect(postActivationRequestPipelineText).toContain('Payload preview: ready: POST /mission-control/internal-send-activation-decision-audits · This is the exact workbench payload preview for Record decision audit; it is not submitted by the status surface.');
    expect(postActivationRequestPipelineText).toContain('Payload body: {"internalSendActivationRequestToken":"mission-send-activation-request-test"}');
    expect(postActivationRequestPipelineText).toContain('Handler drift check: matched: createInternalSendActivationDecisionAudit · createInternalSendActivationDecisionAudit expects POST /mission-control/internal-send-activation-decision-audits with internalSendActivationRequestToken; payload preview matches that workbench handler contract.');
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
    expect(activationAuditText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(activationAuditText).toContain('Reviewer: architect_or_oracle · pending review');
    expect(activationAuditText).toContain('Decision: refuse live activation until separate gate; activation allowed: no');
    expect(activationAuditText).toContain('Refusal: refused_for_live_execution · No live hm-send execution is allowed from this review-only audit artifact.');
    expect(activationAuditText).toContain('Rollback audit: rollback_audit_previewed · snapshot: required · failure audit: required');
    expect(activationAuditText).toContain('decision/refusal/rollback audit only; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    expect(harness.elements.routeInternalSendActivationRequestList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendActivationRequestList.children[0].attributes.id || '').toBe('');
    expect(harness.elements.routeInternalSendActivationAuditList.children[0].className).toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendActivationAuditList.children[0].attributes.id).toBe('mission-control-manual-step-activation-decision-audit-mission-send-activation-audit-test');
    const postDecisionAuditPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const postDecisionAuditStepHeader = postDecisionAuditPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(postDecisionAuditStepHeader.textContent).toBe('Next manual step: Check implementation readiness on Decision audit. Manual-only. Use the existing highlighted card/button; this status card does not submit.');
    expect(postDecisionAuditStepHeader.children).toHaveLength(1);
    expect(postDecisionAuditStepHeader.children[0].attributes.href).toBe('#mission-control-manual-step-activation-decision-audit-mission-send-activation-audit-test');
    const postDecisionAuditPipelineText = postDecisionAuditPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(postDecisionAuditPipelineText).toContain('Current stage: Decision audit: activation decision audit review only; token mission-send-activation-audit-test.');
    expect(postDecisionAuditPipelineText).toContain('Last saved: Decision audit: activation_decision_audit_review_only; token mission-send-activation-audit-test');
    expect(postDecisionAuditPipelineText).toContain('Current evidence: token mission-send-activation-audit-test; status saved; path mission-control/internal-send-activation-decision-audits/mission-send-activation-audit-test.json; relation activation_request -> activation_decision_audit; source token mission-send-activation-request-test; body body-sha256-test; adapter adapter-packet-sha256');
    expect(postDecisionAuditPipelineText).toContain('Advance selector: advance available: Decision audit -> Implementation readiness. Decision audit is the latest available stage before the first missing stage, Implementation readiness.');
    expect(postDecisionAuditPipelineText).toContain('Manual action preflight: ready: Check implementation readiness · Check implementation readiness is the next manual internal action because Decision audit is selected and Implementation readiness is the first missing stage. Use the selected token as internalSendActivationDecisionAuditToken; this preflight does not perform the action.');
    expect(postDecisionAuditPipelineText).toContain('Manual action input: internalSendActivationDecisionAuditToken=mission-send-activation-audit-test; source mission-control/internal-send-activation-decision-audits/mission-send-activation-audit-test.json; next Implementation readiness');
    expect(postDecisionAuditPipelineText).toContain('Selected artifact: token mission-send-activation-audit-test; path mission-control/internal-send-activation-decision-audits/mission-send-activation-audit-test.json; source mission-send-activation-request-test; body body-sha256-test; adapter adapter-packet-sha256');
    expect(postDecisionAuditPipelineText).toContain('Workbench focus: Highlight the existing Decision audit card at mission-control/internal-send-activation-decision-audits/mission-send-activation-audit-test.json and use its existing Check implementation readiness action.');
    expect(postDecisionAuditPipelineText).toContain('Manual selector summary: ready: Check implementation readiness on Decision audit; internalSendActivationDecisionAuditToken=mission-send-activation-audit-test; POST /mission-control/internal-send-activation-implementation-readiness; manual-only because this status card does not submit.');
    expect(postDecisionAuditPipelineText).toContain('Payload preview: ready: POST /mission-control/internal-send-activation-implementation-readiness · This is the exact workbench payload preview for Check implementation readiness; it is not submitted by the status surface.');
    expect(postDecisionAuditPipelineText).toContain('Payload body: {"internalSendActivationDecisionAuditToken":"mission-send-activation-audit-test"}');
    expect(postDecisionAuditPipelineText).toContain('Handler drift check: matched: createInternalSendActivationImplementationReadiness · createInternalSendActivationImplementationReadiness expects POST /mission-control/internal-send-activation-implementation-readiness with internalSendActivationDecisionAuditToken; payload preview matches that workbench handler contract.');
    const implementationReadinessCallsBeforeClick = harness.calls.filter((call) => call.url === '/mission-control/internal-send-activation-implementation-readiness');
    expect(implementationReadinessCallsBeforeClick.every((call) => call.method === 'GET')).toBe(true);
    expect(implementationReadinessCallsBeforeClick).toHaveLength(10);
    const implementationReadinessButton = harness.elements.routeInternalSendActivationAuditList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Check implementation readiness');
    expect(implementationReadinessButton.textContent).toBe('Check implementation readiness');
    expect(implementationReadinessButton.className).toContain('selected-manual-action');
    expect(implementationReadinessButton.attributes['aria-label']).toBe('Selected Mission Control action: Check implementation readiness');
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
    expect(implementationReadinessText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(implementationReadinessText).toContain('Implementation gate: enabled: no; activation allowed: no; live hm-send: no');
    expect(implementationReadinessText).toContain('Refusal: live_activation_still_refused · Implementation readiness is review-only and remains disabled until a separate activation implementation gate exists.');
    expect(implementationReadinessText).toContain('Rollback: rollback_requirements_ready · snapshot: required · failure audit: required');
    expect(implementationReadinessText).toContain('implementation readiness only; disabled by default; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    expect(harness.elements.routeInternalSendActivationAuditList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendActivationAuditList.children[0].attributes.id || '').toBe('');
    expect(harness.elements.routeInternalSendActivationReadinessList.children[0].className).toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendActivationReadinessList.children[0].attributes.id).toBe('mission-control-manual-step-activation-implementation-readiness-mission-send-activation-ready-test');
    const postImplementationReadinessPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const postImplementationReadinessStepHeader = postImplementationReadinessPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(postImplementationReadinessStepHeader.textContent).toBe('Next manual step: Define live gate contract on Implementation readiness. Manual-only. Use the existing highlighted card/button; this status card does not submit.');
    expect(postImplementationReadinessStepHeader.children).toHaveLength(1);
    expect(postImplementationReadinessStepHeader.children[0].attributes.href).toBe('#mission-control-manual-step-activation-implementation-readiness-mission-send-activation-ready-test');
    const postImplementationReadinessPipelineText = postImplementationReadinessPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(postImplementationReadinessPipelineText).toContain('Current stage: Implementation readiness: activation implementation readiness review only; token mission-send-activation-ready-test.');
    expect(postImplementationReadinessPipelineText).toContain('Last saved: Implementation readiness: activation_implementation_readiness_review_only; token mission-send-activation-ready-test');
    expect(postImplementationReadinessPipelineText).toContain('Current evidence: token mission-send-activation-ready-test; status saved; path mission-control/internal-send-activation-implementation-readiness/mission-send-activation-implementation-test.json; relation activation_decision_audit -> activation_implementation_readiness; source token mission-send-activation-audit-test; body body-sha256-test; adapter adapter-packet-sha256');
    expect(postImplementationReadinessPipelineText).toContain('Advance selector: advance available: Implementation readiness -> Live activation hard-stop contract. Implementation readiness is the latest available stage before the first missing stage, Live activation hard-stop contract.');
    expect(postImplementationReadinessPipelineText).toContain('Manual action preflight: ready: Define live gate contract · Define live gate contract is the next manual internal action because Implementation readiness is selected and Live activation hard-stop contract is the first missing stage. Use the selected token as internalSendActivationImplementationReadinessToken; this preflight does not perform the action.');
    expect(postImplementationReadinessPipelineText).toContain('Manual action input: internalSendActivationImplementationReadinessToken=mission-send-activation-ready-test; source mission-control/internal-send-activation-implementation-readiness/mission-send-activation-implementation-test.json; next Live activation hard-stop contract');
    expect(postImplementationReadinessPipelineText).toContain('Selected artifact: token mission-send-activation-ready-test; path mission-control/internal-send-activation-implementation-readiness/mission-send-activation-implementation-test.json; source mission-send-activation-audit-test; body body-sha256-test; adapter adapter-packet-sha256');
    expect(postImplementationReadinessPipelineText).toContain('Workbench focus: Highlight the existing Implementation readiness card at mission-control/internal-send-activation-implementation-readiness/mission-send-activation-implementation-test.json and use its existing Define live gate contract action.');
    expect(postImplementationReadinessPipelineText).toContain('Manual selector summary: ready: Define live gate contract on Implementation readiness; internalSendActivationImplementationReadinessToken=mission-send-activation-ready-test; POST /mission-control/internal-send-live-activation-gate-contracts; manual-only because this status card does not submit.');
    expect(postImplementationReadinessPipelineText).toContain('Payload preview: ready: POST /mission-control/internal-send-live-activation-gate-contracts · This is the exact workbench payload preview for Define live gate contract; it is not submitted by the status surface.');
    expect(postImplementationReadinessPipelineText).toContain('Payload body: {"internalSendActivationImplementationReadinessToken":"mission-send-activation-ready-test"}');
    expect(postImplementationReadinessPipelineText).toContain('Handler drift check: matched: createInternalSendLiveActivationGateContract · createInternalSendLiveActivationGateContract expects POST /mission-control/internal-send-live-activation-gate-contracts with internalSendActivationImplementationReadinessToken; payload preview matches that workbench handler contract.');
    const liveGateCallsBeforeClick = harness.calls.filter((call) => call.url === '/mission-control/internal-send-live-activation-gate-contracts');
    expect(liveGateCallsBeforeClick.every((call) => call.method === 'GET')).toBe(true);
    expect(liveGateCallsBeforeClick).toHaveLength(11);
    const liveGateButton = harness.elements.routeInternalSendActivationReadinessList.children[0].children
      .find((child) => child.tagName === 'BUTTON' && child.textContent === 'Define live gate contract');
    expect(liveGateButton.textContent).toBe('Define live gate contract');
    expect(liveGateButton.className).toContain('selected-manual-action');
    expect(liveGateButton.attributes['aria-label']).toBe('Selected Mission Control action: Define live gate contract');
    await liveGateButton.listeners.click();

    const liveGateCalls = harness.calls.filter((call) => call.url === '/mission-control/internal-send-live-activation-gate-contracts');
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(11);
    expect(liveGateCalls).toEqual([
      ...Array.from({ length: 11 }, () => expect.objectContaining({ method: 'GET' })),
      expect.objectContaining({
        method: 'POST',
        body: {
          internalSendActivationImplementationReadinessToken: 'mission-send-activation-ready-test',
        },
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(harness.elements.routeInternalSendLiveGateList.children).toHaveLength(1);
    const liveGateText = harness.elements.routeInternalSendLiveGateList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(liveGateText).toContain('oracle · live activation hard-stop contract');
    expect(liveGateText).toContain('live activation gate hard stop · James setup required before live send · not sent');
    expect(liveGateText).toContain('Pane target: oracle pane 3');
    expect(liveGateText).toContain('Body: Edited internal continuation for Oracle review.');
    expect(liveGateText).toContain('Mission answer: Project/lane: squidrun / architect#253.');
    expect(liveGateText).toContain('Hard stop: live activation: no; implementation enabled: no; James setup required: yes');
    expect(liveGateText).toContain('James/setup: James must explicitly request a later live internal-send activation for this exact target and body.');
    expect(liveGateText).toContain('hard-stop contract only; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery');
    expect(harness.elements.routeInternalSendActivationReadinessList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendActivationReadinessList.children[0].attributes.id || '').toBe('');
    expect(harness.elements.routeInternalSendLiveGateList.children[0].className).not.toContain('selected-manual-source');
    expect(harness.elements.routeInternalSendLiveGateList.children[0].attributes.id || '').toBe('');
    const selectedManualButtonsAfterHardStop = [
      ...harness.elements.routePreviewHistoryList.children,
      ...harness.elements.routeRequestList.children,
      ...harness.elements.routeContinuationList.children,
      ...harness.elements.routeDeliveryPreviewList.children,
      ...harness.elements.routeDispatchReadinessList.children,
      ...harness.elements.routeInternalSendDryRunList.children,
      ...harness.elements.routeInternalSendActivationDesignList.children,
      ...harness.elements.routeInternalSendActivationRequestList.children,
      ...harness.elements.routeInternalSendActivationAuditList.children,
      ...harness.elements.routeInternalSendActivationReadinessList.children,
      ...harness.elements.routeInternalSendLiveGateList.children,
    ].flatMap((card) => card.children || [])
      .filter((child) => child.tagName === 'BUTTON' && String(child.className || '').includes('selected-manual-action'));
    expect(selectedManualButtonsAfterHardStop).toHaveLength(0);
    expect(harness.calls.some((call) => call.url === '/bridge/manual-plan')).toBe(false);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Internal delivery preview saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Dispatch-readiness checklist saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Internal-send dry-run audit saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Activation-design proof saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Activation request preview saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Activation decision audit saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Activation implementation readiness saved locally. Nothing was sent or executed.');
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toContain('Live activation gate contract saved locally. Nothing was sent or executed.');
    const pipelineStatusCalls = harness.calls.filter((call) => call.url === '/mission-control/activation-pipeline-status');
    expect(pipelineStatusCalls.length).toBeGreaterThan(1);
    expect(pipelineStatusCalls.every((call) => call.method === 'GET')).toBe(true);
    expect(pipelineStatusCalls.some((call) => call.method === 'POST')).toBe(false);
    const hardStopPipelineCard = harness.elements.routeActivationPipelineStatus.children[0];
    const hardStopStepHeader = hardStopPipelineCard.children.find((child) => child.dataset?.missionManualStepHeader === 'true');
    expect(hardStopStepHeader.textContent).toBe('Next manual step: none ready. Read-only status card only; no manual action is selected.');
    expect(hardStopStepHeader.children).toHaveLength(0);
    const pipelineStatusText = hardStopPipelineCard.children
      .map((child) => child.textContent)
      .join('\n');
    expect(pipelineStatusText).toContain('Activation pipeline status');
    expect(pipelineStatusText).toContain('Live activation hard-stop contract · read only · not sent');
    expect(pipelineStatusText).toContain('Current stage: Live activation hard-stop contract: live activation gate hard stop; token mission-send-live-gate-test.');
    expect(pipelineStatusText).toContain('Last saved: Live activation hard-stop contract: live_activation_gate_hard_stop; token mission-send-live-gate-test');
    expect(pipelineStatusText).toContain('Readout: Mission Control send chain is complete to the hard stop; live send is unavailable.');
    expect(pipelineStatusText).toContain('Completed chain: 12/12 stages have saved or derived local evidence.');
    expect(pipelineStatusText).toContain('What was proven: Saved local evidence covers route preview through live activation hard-stop contract; the status refresh is read-only and no next artifact is available.');
    expect(pipelineStatusText).toContain('Manual-only: All advancement before the hard stop used explicit workbench actions; this readout has no submit, send, execution, provider, route, account, or token path.');
    expect(pipelineStatusText).toContain('Readout boundary: The chain is at the hard-stop contract. Live send is unavailable; future real send would require a separate James-visible setup/activation lane.');
    expect(pipelineStatusText).toContain('Mission answer continuity: Same originating Mission Control answer appears across 12/12 available stages from Route preview to Live activation hard-stop contract.');
    expect(pipelineStatusText).toContain('Mission answer source: Project/lane: squidrun / architect#253.');
    expect(pipelineStatusText).toContain('Mission answer trail: Route preview: same -> Review item: same -> Owned-work continuation: same -> Follow-through recommendation: same -> Delivery preview: same -> Dispatch readiness: same -> Internal-send dry run: same -> Activation design: same -> Activation request: same -> Decision audit: same -> Implementation readiness: same -> Live activation hard-stop contract: same');
    expect(pipelineStatusText).toContain('Demo path: Open the local New Mira workbench and read the Mission Control activation pipeline status card. Read: Readout / Completed chain / What was proven / Manual-only / Readout boundary.');
    expect(pipelineStatusText).toContain('Demo meaning: The demo shows Mission Control can explain a complete saved local coordination chain from artifacts, ending at a hard stop instead of pretending to send.');
    expect(pipelineStatusText).toContain('Demo boundary: This demo path only reads existing status/artifact evidence; it does not submit, send, execute, call a model/provider, flip routes, or access accounts/tokens.');
    expect(pipelineStatusText).toContain('Inspection runbook: Local New Mira workbench -> Mission Control activation pipeline status card Steps: Open the local New Mira workbench / Find the Activation pipeline status card / Read Demo path, Completed chain, What was proven, Manual-only, and Readout boundary / Confirm terminal hard-stop/no-live-send truth before any future activation discussion.');
    expect(pipelineStatusText).toContain('Inspection expected: terminal hard stop / 12/12 stages available / live send unavailable / future real send requires a separate James-visible setup/activation lane');
    expect(pipelineStatusText).toContain('Inspection boundary: Inspection is read-only product clarity over saved local artifacts/status; it is not a dispatch, activation, model turn, route flip, or external action.');
    expect(pipelineStatusText).toContain('Demo walkthrough: Mission Control completed-chain hard-stop walkthrough');
    expect(pipelineStatusText).toContain('Walkthrough evidence: current stage: Live activation hard-stop contract / artifact token: mission-send-live-gate-test / artifact path: mission-control/internal-send-live-activation-gate-contracts/mission-send-live-gate-test.json / saved stages: 12/12');
    expect(pipelineStatusText).toContain('Walkthrough steps: Mission Control reads the saved local coordination chain from route preview through live-gate contract. / It shows the current evidence is the live activation hard-stop contract, backed by token/path/source checksums. / It explains that the chain is complete as an inspection demo, but live send is not available from this surface. / It points the next boundary at a separate James-visible setup/activation lane for any future real send proposal.');
    expect(pipelineStatusText).toContain('Why useful: This is useful because Mission Control turns saved local team-work artifacts into an inspectable next-state explanation instead of generic chat.');
    expect(pipelineStatusText).toContain('Still manual: The walkthrough does not click, submit, send, execute, call a provider/model, flip routes, or access accounts/tokens.');
    expect(pipelineStatusText).toContain('What now: Inspect the local status card as a completed Mission Control demo; the chain ends at a hard stop, not a live send.');
    expect(pipelineStatusText).toContain('What now meaning: The saved chain is complete as a read-only demo: 12/12 stages are available and the current artifact is Live activation hard-stop contract.');
    expect(pipelineStatusText).toContain("Inspect next: Read the status card's Readout, Current evidence, Trace path, Demo walkthrough, and Hard stop rows.");
    expect(pipelineStatusText).toContain('No live action: Live action is unavailable because this status projection is read-only and any real send requires a separate James-visible setup/activation lane.');
    expect(pipelineStatusText).toContain('What now evidence: current stage: Live activation hard-stop contract / artifact token: mission-send-live-gate-test / artifact path: mission-control/internal-send-live-activation-gate-contracts/mission-send-live-gate-test.json / available stages: 12/12 / live send available: false');
    expect(pipelineStatusText).toContain('Hard stop: live send available: no; hard-stop contract: yes; James setup before live send: yes');
    expect(pipelineStatusText).toContain('Future real send would require a separate James-visible setup/activation lane.');
    expect(pipelineStatusText).toContain('Trace path: Route preview -> Review item -> Owned-work continuation -> Follow-through recommendation -> Delivery preview -> Dispatch readiness -> Internal-send dry run -> Activation design -> Activation request -> Decision audit -> Implementation readiness -> Live activation hard-stop contract');
    expect(pipelineStatusText).toContain('Current evidence: token mission-send-live-gate-test; status saved; path mission-control/internal-send-live-activation-gate-contracts/mission-send-live-gate-test.json; relation activation_implementation_readiness -> live_activation_gate_contract; source token mission-send-activation-ready-test; body ');
    expect(pipelineStatusText).toContain('adapter ');
    expect(pipelineStatusText).toContain('Body preview: Edited internal continuation for Oracle review.');
    expect(pipelineStatusText).toContain('Advance selector: hard stop reached: Live activation hard-stop contract -> no next stage. The chain is already at the live activation hard-stop contract. This read-only surface has no next artifact to advance; future real send would require a separate James-visible setup/activation lane.');
    expect(pipelineStatusText).toContain('Selected artifact: token mission-send-live-gate-test; path mission-control/internal-send-live-activation-gate-contracts/mission-send-live-gate-test.json; source mission-send-activation-ready-test; body ');
    expect(pipelineStatusText).toContain('Comparison: Compared 12 available stage(s); no advancement is available after the hard-stop contract.');
    expect(pipelineStatusText).toContain('Manual action preflight: blocked hard stop: no manual action · No manual advancement is available from this read-only surface because the selected artifact is the live activation hard-stop contract.');
    expect(pipelineStatusText).toContain('Manual action input: No manual action input is ready.');
    expect(pipelineStatusText).toContain('Workbench focus: No manual workbench step is ready to highlight.');
    expect(pipelineStatusText).toContain('Manual selector summary: blocked: no existing manual action is ready to select.');
    expect(pipelineStatusText).toContain('Manual-only checklist: ok: status surface is read-only / blocked: manual preflight ready (blocked_hard_stop) / blocked: highlighted source available (no) / blocked: payload matches handler (blocked) / ok: selector summary does not submit anything');
    expect(pipelineStatusText).toContain('blocked: A next missing stage exists for manual advancement.');
    expect(pipelineStatusText).toContain('Payload preview: blocked: no method no endpoint · No payload preview is available because the manual action preflight is blocked.');
    expect(pipelineStatusText).toContain('Payload body: No payload body is available.');
    expect(pipelineStatusText).toContain('Payload validation: blocked: Manual action preflight is ready. / blocked: Existing workbench endpoint is known. / blocked: Selected artifact token is present in the preview payload. / ok: Payload preview is derived from GET status and is not submitted or persisted.');
    expect(pipelineStatusText).toContain('Handler drift check: blocked: no handler · No workbench handler drift check is available because the manual action preflight is blocked.');
    expect(pipelineStatusText).toContain('Handler contract: no method no endpoint; token no token; body none');
    expect(pipelineStatusText).toContain('Handler checks: blocked: Manual action preflight is ready. / blocked: Workbench handler method matches the payload preview method. / blocked: Workbench handler endpoint matches the payload preview endpoint.');
    expect(pipelineStatusText).toContain('Trace audit: Read-only trace only; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery.');
    expect(pipelineStatusText).not.toContain('live send available: yes');
    expect(harness.elements.routeInternalSendLiveGateList.children[0].className).not.toContain('selected-manual-source');
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
    const missionReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
    expect(missionReply).toContain('Next team move: Builder implements Mission Control v0; Oracle reviews it against the benchmark before commit.');
    expect(missionReply).toContain('Foundation vs product: SquidRun context is foundation.');
    expect((missionReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
    expect(harness.elements.lastTurn.textContent).toBe('mission control local');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('shows the same status-backed what-now answer in the panel, status card, and typed reply', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    await advanceMissionControlChainToHardStop(harness);
    const statusCardText = harness.elements.routeActivationPipelineStatus.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(statusCardText).toContain('What now: Inspect the local status card as a completed Mission Control demo; the chain ends at a hard stop, not a live send.');
    expect(statusCardText).toContain('What now meaning: The saved chain is complete as a read-only demo: 12/12 stages are available and the current artifact is Live activation hard-stop contract.');
    expect(statusCardText).toContain("Inspect next: Read the status card's Readout, Current evidence, Trace path, Demo walkthrough, and Hard stop rows.");
    expect(statusCardText).toContain('No live action: Live action is unavailable because this status projection is read-only and any real send requires a separate James-visible setup/activation lane.');
    expect(harness.elements.missionAnswer.textContent).toContain('What now: Inspect the local status card as a completed Mission Control demo; the chain ends at a hard stop, not a live send.');
    expect(harness.elements.missionAnswer.textContent).toContain('Meaning: The saved chain is complete as a read-only demo: 12/12 stages are available and the current artifact is Live activation hard-stop contract.');
    expect(harness.elements.missionAnswer.textContent).toContain("Inspect next: Read the status card's Readout, Current evidence, Trace path, Demo walkthrough, and Hard stop rows.");
    expect(harness.elements.missionAnswer.textContent).toContain('No live action: Live action is unavailable because this status projection is read-only and any real send requires a separate James-visible setup/activation lane.');
    expect(harness.elements.missionAnswer.textContent).toContain('Next boundary: The chain is at the hard-stop contract. Live send is unavailable; future real send would require a separate James-visible setup/activation lane.');
    expect((harness.elements.missionAnswer.textContent.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
    const visiblePanelAnswer = harness.elements.missionAnswer.textContent;
    const routePreviewPostCountBeforeSave = harness.calls
      .filter((call) => call.url === '/mission-control/route-previews' && call.method === 'POST')
      .length;
    await harness.elements.saveRoutePreviewButton.listeners.click();
    const routePreviewPostCalls = harness.calls
      .filter((call) => call.url === '/mission-control/route-previews' && call.method === 'POST');
    expect(routePreviewPostCalls).toHaveLength(routePreviewPostCountBeforeSave + 1);
    expect(routePreviewPostCalls[routePreviewPostCalls.length - 1].body.missionAnswer).toBe(visiblePanelAnswer);
    const savedPreviewText = harness.elements.routePreviewHistoryList.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(savedPreviewText).toContain('Mission answer: What now: Inspect the local status card as a completed Mission Control demo; the chain ends at a hard stop, not a live send.');
    expect(savedPreviewText).toContain('Meaning: The saved chain is complete as a read-only demo: 12/12 stages are available and the current artifact is Live activation hard-stop contract.');
    expect(savedPreviewText).toContain('Next boundary: The chain is at the hard-stop contract. Live send is unavailable; future real send would require a separate James-visible setup/activation lane.');

    harness.elements.turnText.value = 'what now?';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
      'what now?',
      expect.stringContaining('What now: Inspect the local status card as a completed Mission Control demo; the chain ends at a hard stop, not a live send.'),
    ]);
    const missionReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
    expect(missionReply).toContain('Meaning: The saved chain is complete as a read-only demo: 12/12 stages are available and the current artifact is Live activation hard-stop contract.');
    expect(missionReply).toContain("Inspect next: Read the status card's Readout, Current evidence, Trace path, Demo walkthrough, and Hard stop rows.");
    expect(missionReply).toContain('No live action: Live action is unavailable because this status projection is read-only and any real send requires a separate James-visible setup/activation lane.');
    expect(missionReply).toContain('Next boundary: The chain is at the hard-stop contract. Live send is unavailable; future real send would require a separate James-visible setup/activation lane.');
    expect(missionReply).toBe(visiblePanelAnswer);
    expect((missionReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
    expect(postCalls.every((call) => call.url !== '/turn')).toBe(true);
    expect(harness.elements.lastTurn.textContent).toBe('mission control local');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('answers demo inspection questions from the existing status-backed readout without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    await advanceMissionControlChainToHardStop(harness);
    const statusCardText = harness.elements.routeActivationPipelineStatus.children[0].children
      .map((child) => child.textContent)
      .join('\n');
    expect(statusCardText).toContain('Demo path: Open the local New Mira workbench and read the Mission Control activation pipeline status card.');
    expect(statusCardText).toContain('Mission answer continuity: Same originating Mission Control answer appears across 12/12 available stages from Route preview to Live activation hard-stop contract.');

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    harness.elements.turnText.value = 'show me the Mission Control demo inspection path';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
      'show me the Mission Control demo inspection path',
      expect.stringContaining('Demo path: Open the local New Mira workbench and read the Mission Control activation pipeline status card. Read: Readout / Completed chain / What was proven / Manual-only / Readout boundary.'),
    ]);
    const demoReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
    expect(demoReply).toContain('What it shows: The demo shows Mission Control can explain a complete saved local coordination chain from artifacts, ending at a hard stop instead of pretending to send.');
    expect(demoReply).toContain('Inspection steps: Open the local New Mira workbench / Find the Activation pipeline status card / Read Demo path, Completed chain, What was proven, Manual-only, and Readout boundary / Confirm terminal hard-stop/no-live-send truth before any future activation discussion');
    expect(demoReply).toContain('Why useful: This is useful because Mission Control turns saved local team-work artifacts into an inspectable next-state explanation instead of generic chat.');
    expect(demoReply).toContain('Continuity: Same originating Mission Control answer appears across 12/12 available stages from Route preview to Live activation hard-stop contract.');
    expect(demoReply).toContain('Boundary: Inspection is read-only product clarity over saved local artifacts/status; it is not a dispatch, activation, model turn, route flip, or external action.');
    expect(demoReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
    expect((demoReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
    expect(harness.elements.lastTurn.textContent).toBe('mission control local');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('answers coordination draft questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    expect(harness.elements.coordinationDraftList.children).toHaveLength(2);
    expect(harness.elements.coordinationDraftList.children[1].children[0].textContent).toBe('oracle · benchmark review');
    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    harness.elements.turnText.value = 'what should I tell Oracle?';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
      'what should I tell Oracle?',
      expect.stringContaining('Coordination target: oracle · benchmark review'),
    ]);
    const coordinationReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
    expect(coordinationReply).toContain('Message preview: Challenge Mission Control v0 against the external-agent benchmark.');
    expect(coordinationReply).toContain('Source: already-loaded Mission Control coordination draft from local SquidRun context.');
    expect(coordinationReply).toContain('Boundary: local preview only; no Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
    expect(coordinationReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
    expect((coordinationReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
    expect(harness.elements.lastTurn.textContent).toBe('mission control local');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('answers local-preview availability questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['what can I ask Mission Control locally?', 'what local previews are available?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Available local previews:'),
      ]);
      const availableReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(availableReply).toContain('what now / what is happening here');
      expect(availableReply).toContain('coordination draft preview');
      expect(availableReply).toContain('route preview');
      expect(availableReply).toContain('project/workspace identity');
      expect(availableReply).toContain('active lane');
      expect(availableReply).toContain('evidence/source list');
      expect(availableReply).toContain('owned-work queue');
      expect(availableReply).toContain('dirty work/git status');
      expect(availableReply).toContain('recent Architect/Oracle context');
      expect(availableReply).toContain('roadmap/north-star/stop-pivot');
      expect(availableReply).toContain('foundation-vs-product framing');
      expect(availableReply).toContain('whether James is needed');
      expect(availableReply).toContain('Example prompts: what now? / what project is loaded? / what lane are we on? / what changed here? / what did Oracle say? / is James needed?');
      expect(availableReply).toContain('Source: already-loaded Mission Control UI state and /squidrun/context; this only names existing local answers.');
      expect(availableReply).toContain('Boundary: local inspection only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
      expect(availableReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((availableReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers live-send boundary questions from existing Mission Control status without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['is live send available in Mission Control?', 'what is the Mission Control live-send boundary?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Live send available: no'),
      ]);
      const boundaryReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(boundaryReply).toContain('Hard stop recorded: no');
      expect(boundaryReply).toContain('James setup required before live send: yes');
      expect(boundaryReply).toContain('Current stage: No Mission Control send chain yet');
      expect(boundaryReply).toContain('Next boundary: Next inspectable step is local review; live send is still unavailable.');
      expect(boundaryReply).toContain('Future gate: Future real send would require a separate James-visible setup/activation lane.');
      expect(boundaryReply).toContain('Source: already-loaded Mission Control activation pipeline status from local SquidRun context.');
      expect(boundaryReply).toContain('Boundary: local inspection only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, runtime execution, or external send.');
      expect(boundaryReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((boundaryReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers manual-action questions from existing Mission Control status without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['what manual action is next in Mission Control?', 'which Mission Control button is highlighted?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Manual action ready: no'),
      ]);
      const manualActionReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(manualActionReply).toContain('Selected action: No manual action is ready.');
      expect(manualActionReply).toContain('Selected source: No highlighted Mission Control source is ready.');
      expect(manualActionReply).toContain('Source path: No saved source path is ready.');
      expect(manualActionReply).toContain('Payload preview: no method no endpoint; no token=not ready');
      expect(manualActionReply).toContain('Handler drift: blocked · no handler');
      expect(manualActionReply).toContain('Next boundary: Next inspectable step is local review; live send is still unavailable.');
      expect(manualActionReply).toContain('Source: already-loaded Mission Control activation pipeline status/focus from local SquidRun context.');
      expect(manualActionReply).toContain('Boundary: local inspection only; no /turn, fetch, POST, persistence, button click, Telegram, hm-send, route flip, provider/model call, account/token access, runtime execution, or external send.');
      expect(manualActionReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((manualActionReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers artifact-evidence questions from existing Mission Control status without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['where is the current Mission Control artifact?', 'what is the Mission Control evidence path?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Current evidence ready: no'),
      ]);
      const artifactReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(artifactReply).toContain('Current stage: No saved Mission Control send chain yet');
      expect(artifactReply).toContain('Artifact token: not available');
      expect(artifactReply).toContain('Artifact path: No saved artifact path is available.');
      expect(artifactReply).toContain('Source relation: No saved source relation is available.');
      expect(artifactReply).toContain('Checksums: No checksum recorded.');
      expect(artifactReply).toContain('Trace path: No saved Mission Control activation artifacts yet.');
      expect(artifactReply).toContain('Body preview: No body preview recorded.');
      expect(artifactReply).toContain('Source: already-loaded Mission Control activation pipeline status/trace from local SquidRun context.');
      expect(artifactReply).toContain('Boundary: local inspection only; no /turn, fetch, POST, persistence, file read, Telegram, hm-send, route flip, provider/model call, account/token access, runtime execution, or external send.');
      expect(artifactReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((artifactReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers proof-summary questions from existing Mission Control status without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['what did Mission Control prove?', 'what proof summary is loaded in Mission Control?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Proof status: empty'),
      ]);
      const proofReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(proofReply).toContain('Completed chain: 0/12 stages have saved or derived local evidence; missing Route preview, Review item, Owned-work continuation');
      expect(proofReply).toContain('What was proven: No saved chain evidence exists yet.');
      expect(proofReply).toContain('Manual-only proof: No manual advancement is ready from this readout.');
      expect(proofReply).toContain('Hard-stop truth: live send available no; hard-stop recorded no; separate activation lane yes.');
      expect(proofReply).toContain('Next boundary: Next inspectable step is local review; live send is still unavailable.');
      expect(proofReply).toContain('Source: already-loaded Mission Control activation pipeline status/readout from local SquidRun context.');
      expect(proofReply).toContain('Boundary: local inspection only; no /turn, fetch, POST, persistence, click, file read, Telegram, hm-send, route flip, provider/model call, account/token access, runtime execution, or external send.');
      expect(proofReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((proofReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers recent team-context questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['what did Oracle say?', 'what is the Oracle benchmark?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Oracle benchmark: oracle#104'),
      ]);
      const recentCommsReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(recentCommsReply).toContain('Oracle benchmark: oracle#104 - Current New Mira is not impressive yet; Mission Control must prove command-layer value.');
      expect(recentCommsReply).toContain('Latest Architect instruction: architect#253 - Build the smallest judgment/conversation layer on top of local evidence.');
      expect(recentCommsReply).toContain('Hard truth: Current New Mira is not holy-shit amazing.');
      expect(recentCommsReply).toContain('Stop/pivot: Stop or pivot if Mission Control cannot answer from local evidence.');
      expect(recentCommsReply).toContain('Boundary: local answer only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
      expect(recentCommsReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((recentCommsReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers roadmap questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['what is the north star?', 'when do we stop or pivot?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('North star: Name: Mira Mission Control v0.'),
      ]);
      const roadmapReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(roadmapReply).toContain('Hard truth: Current New Mira is not holy-shit amazing.');
      expect(roadmapReply).toContain('Stop/pivot: Stop or pivot if Mission Control cannot answer from local evidence.');
      expect(roadmapReply).toContain('Next gate: Build Mission Control v0.');
      expect(roadmapReply).toContain('Source: docs/mira-north-star-roadmap.md / docs/mira-system-map.md');
      expect(roadmapReply).toContain('Boundary: local answer only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
      expect(roadmapReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((roadmapReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers product-framing questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['is this foundation or product?', 'what is the Mission Control product test?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Foundation vs product: SquidRun context is foundation.'),
      ]);
      const productReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(productReply).toContain('The product test is whether Mira can operate as Mission Control for James\'s AI team.');
      expect(productReply).toContain('First demo: Name: Mira Mission Control v0.');
      expect(productReply).toContain('Hard truth: Current New Mira is not holy-shit amazing.');
      expect(productReply).toContain('Next move: Builder implements Mission Control v0; Oracle reviews it against the benchmark before commit.');
      expect(productReply).toContain('Boundary: local answer only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
      expect(productReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((productReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers route-preview questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    expect(harness.elements.routePreviewSummary.textContent).toContain('Route preview: oracle · benchmark review');
    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    harness.elements.turnText.value = 'what route preview is prepared?';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
      'what route preview is prepared?',
      expect.stringContaining('Route preview: oracle · benchmark review'),
    ]);
    const previewReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
    expect(previewReply).toContain('Message preview: Challenge Mission Control v0 against the external-agent benchmark.');
    expect(previewReply).toContain('Source: already-loaded Mission Control internal route preview from local SquidRun context.');
    expect(previewReply).toContain('Boundary: local preview only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
    expect(previewReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
    expect((previewReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
    expect(harness.elements.lastTurn.textContent).toBe('mission control local');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('answers project/workspace questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['what project is loaded?', 'what workspace is this?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Project: squidrun'),
      ]);
      const projectReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(projectReply).toContain('Workspace: D:/projects/squidrun');
      expect(projectReply).toContain('SquidRun root: D:/projects/squidrun');
      expect(projectReply).toContain('Session: app-session-377');
      expect(projectReply).toContain('Loaded reads: link / currentLane / ownedWorkQueue / gitStatus / systemMap / roadmap / recentComms');
      expect(projectReply).toContain('Boundary: local answer only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
      expect(projectReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((projectReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers active-lane questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['what lane are we on?', 'what is the current Mission Control lane?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Active lane: architect#253 (active)'),
      ]);
      const laneReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(laneReply).toContain('Target role: builder');
      expect(laneReply).toContain('Objective: Build Mission Control from actual local SquidRun evidence.');
      expect(laneReply).toContain('Next action: Builder implements Mission Control v0; Oracle reviews it against the benchmark before commit.');
      expect(laneReply).toContain('Boundary: local answer only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
      expect(laneReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((laneReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers evidence-source questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    harness.elements.turnText.value = 'what evidence is Mission Control based on?';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
      'what evidence is Mission Control based on?',
      expect.stringContaining('Evidence scope: squidrun / architect#253'),
    ]);
    const evidenceReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
    expect(evidenceReply).toContain('Evidence sources: .squidrun/link.json / git status --short / docs/mira-north-star-roadmap.md');
    expect(evidenceReply).toContain('Loaded reads: link / currentLane / ownedWorkQueue / gitStatus / systemMap / roadmap / recentComms');
    expect(evidenceReply).toContain('Map truth: Current New Mira is not holy-shit amazing.');
    expect(evidenceReply).toContain('Boundary: local answer only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
    expect(evidenceReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
    expect((evidenceReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
    expect(harness.elements.lastTurn.textContent).toBe('mission control local');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('answers owned-work questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['what owned work is pending?', 'what is in the Mission Control work queue?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Owned work: squidrun'),
      ]);
      const ownedWorkReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(ownedWorkReply).toContain('Pending count: 2');
      expect(ownedWorkReply).toContain('Active items: No active owned-work items loaded.');
      expect(ownedWorkReply).toContain('Current lane: architect#253: Build Mission Control from actual local SquidRun evidence.');
      expect(ownedWorkReply).toContain('Next step: Builder implements Mission Control v0; Oracle reviews it against the benchmark before commit.');
      expect(ownedWorkReply).toContain('Boundary: local answer only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
      expect(ownedWorkReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((ownedWorkReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers dirty-work questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['what changed here?', 'what files are dirty?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('Local changes: squidrun / main'),
      ]);
      const dirtyWorkReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(dirtyWorkReply).toContain('Dirty summary: 3 changed file(s): mira/ui/app.js, mira/ui/index.html, mira/runtime/src/squidrun-context.ts.');
      expect(dirtyWorkReply).toContain('Changed files: mira/ui/app.js / mira/ui/index.html / mira/runtime/src/squidrun-context.ts');
      expect(dirtyWorkReply).toContain('Git status preview: M mira/ui/app.js / M mira/ui/index.html / A mira/runtime/src/squidrun-context.ts');
      expect(dirtyWorkReply).toContain('Mission answer context: Dirty work: 3 changed file(s): mira/ui/app.js, mira/ui/index.html, mira/runtime/src/squidrun-context.ts.');
      expect(dirtyWorkReply).toContain('Boundary: local answer only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
      expect(dirtyWorkReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((dirtyWorkReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
  });

  test('answers James-needed questions from existing Mission Control context without a turn POST', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    const postCountBeforeQuestion = harness.calls.filter((call) => call.method === 'POST').length;
    for (const question of ['is James needed?', 'do you need me for this?']) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const postCallsAfterQuestion = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCallsAfterQuestion).toHaveLength(postCountBeforeQuestion);
      expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        expect.stringContaining('James needed: no'),
      ]);
      const jamesNeededReply = harness.elements.thread.children[harness.elements.thread.children.length - 1].children[0].textContent;
      expect(jamesNeededReply).toContain('Reason: Local dry-run Mission Control work; no account setup needed.');
      expect(jamesNeededReply).toContain('Current next step: Builder implements Mission Control v0; Oracle reviews it against the benchmark before commit.');
      expect(jamesNeededReply).toContain('Boundary: local answer only; no /turn, fetch, POST, persistence, Telegram, hm-send, route flip, provider/model call, account/token access, or external send.');
      expect(jamesNeededReply).toContain('JAMES ACTION: NONE - Local dry-run Mission Control work; no account setup needed.');
      expect((jamesNeededReply.match(/JAMES ACTION:/g) || [])).toHaveLength(1);
      expect(harness.elements.lastTurn.textContent).toBe('mission control local');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
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

  test('does not hijack generic do-this instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'please do this with the runtime fixture';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const turnCalls = harness.calls.filter((call) => call.url === '/turn');
    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCalls).toHaveLength(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].body).toEqual(expect.objectContaining({
      text: 'please do this with the runtime fixture',
      useModel: false,
      modelProvider: 'openai_responses',
      modelName: 'gpt-5.5',
    }));
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toEqual([
      'please do this with the runtime fixture',
      'Mira. Deterministic local turn.',
    ]);
    expect(harness.elements.lastTurn.textContent).toBe('deterministic');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('does not hijack generic work instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'please finish the pending work with the runtime fixture';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const turnCalls = harness.calls.filter((call) => call.url === '/turn');
    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCalls).toHaveLength(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].body).toEqual(expect.objectContaining({
      text: 'please finish the pending work with the runtime fixture',
      useModel: false,
      modelProvider: 'openai_responses',
      modelName: 'gpt-5.5',
    }));
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toEqual([
      'please finish the pending work with the runtime fixture',
      'Mira. Deterministic local turn.',
    ]);
    expect(harness.elements.lastTurn.textContent).toBe('deterministic');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('does not hijack generic roadmap instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'please update the roadmap with the runtime fixture';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const turnCalls = harness.calls.filter((call) => call.url === '/turn');
    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCalls).toHaveLength(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].body).toEqual(expect.objectContaining({
      text: 'please update the roadmap with the runtime fixture',
      useModel: false,
      modelProvider: 'openai_responses',
      modelName: 'gpt-5.5',
    }));
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toEqual([
      'please update the roadmap with the runtime fixture',
      'Mira. Deterministic local turn.',
    ]);
    expect(harness.elements.lastTurn.textContent).toBe('deterministic');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('does not hijack generic lane instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'please change lanes with the runtime fixture';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const turnCalls = harness.calls.filter((call) => call.url === '/turn');
    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCalls).toHaveLength(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].body).toEqual(expect.objectContaining({
      text: 'please change lanes with the runtime fixture',
      useModel: false,
      modelProvider: 'openai_responses',
      modelName: 'gpt-5.5',
    }));
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toEqual([
      'please change lanes with the runtime fixture',
      'Mira. Deterministic local turn.',
    ]);
    expect(harness.elements.lastTurn.textContent).toBe('deterministic');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('does not hijack generic project/workspace instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'please describe the project with the runtime fixture';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const turnCalls = harness.calls.filter((call) => call.url === '/turn');
    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCalls).toHaveLength(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].body).toEqual(expect.objectContaining({
      text: 'please describe the project with the runtime fixture',
      useModel: false,
      modelProvider: 'openai_responses',
      modelName: 'gpt-5.5',
    }));
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toEqual([
      'please describe the project with the runtime fixture',
      'Mira. Deterministic local turn.',
    ]);
    expect(harness.elements.lastTurn.textContent).toBe('deterministic');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('does not hijack generic product instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'please describe the product with the runtime fixture';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const turnCalls = harness.calls.filter((call) => call.url === '/turn');
    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCalls).toHaveLength(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].body).toEqual(expect.objectContaining({
      text: 'please describe the product with the runtime fixture',
      useModel: false,
      modelProvider: 'openai_responses',
      modelName: 'gpt-5.5',
    }));
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toEqual([
      'please describe the product with the runtime fixture',
      'Mira. Deterministic local turn.',
    ]);
    expect(harness.elements.lastTurn.textContent).toBe('deterministic');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('does not hijack generic local-preview instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'please list local answers with the runtime fixture';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const turnCalls = harness.calls.filter((call) => call.url === '/turn');
    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCalls).toHaveLength(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].body).toEqual(expect.objectContaining({
      text: 'please list local answers with the runtime fixture',
      useModel: false,
      modelProvider: 'openai_responses',
      modelName: 'gpt-5.5',
    }));
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toEqual([
      'please list local answers with the runtime fixture',
      'Mira. Deterministic local turn.',
    ]);
    expect(harness.elements.lastTurn.textContent).toBe('deterministic');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('does not hijack generic send instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    for (const question of [
      'please send this with the runtime fixture',
      'Mira, can you send this with the runtime fixture?',
      'can you send this local runtime fixture?',
    ]) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const turnCalls = harness.calls.filter((call) => call.url === '/turn');
      const postCalls = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCalls).toHaveLength(turnCalls.length);
      expect(turnCalls[turnCalls.length - 1].body).toEqual(expect.objectContaining({
        text: question,
        useModel: false,
        modelProvider: 'openai_responses',
        modelName: 'gpt-5.5',
      }));
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        'Mira. Deterministic local turn.',
      ]);
      expect(harness.elements.lastTurn.textContent).toBe('deterministic');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
    expect(harness.calls.filter((call) => call.url === '/turn')).toHaveLength(3);
  });

  test('does not hijack generic click instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    for (const question of [
      'please click the Mission Control button with the runtime fixture',
      'use the next button with the runtime fixture',
    ]) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const turnCalls = harness.calls.filter((call) => call.url === '/turn');
      const postCalls = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCalls).toHaveLength(turnCalls.length);
      expect(turnCalls[turnCalls.length - 1].body).toEqual(expect.objectContaining({
        text: question,
        useModel: false,
        modelProvider: 'openai_responses',
        modelName: 'gpt-5.5',
      }));
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        'Mira. Deterministic local turn.',
      ]);
      expect(harness.elements.lastTurn.textContent).toBe('deterministic');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
    expect(harness.calls.filter((call) => call.url === '/turn')).toHaveLength(2);
  });

  test('does not hijack generic artifact path instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    for (const question of [
      'please open the Mission Control artifact path with the runtime fixture',
      'read the local evidence file with the runtime fixture',
    ]) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const turnCalls = harness.calls.filter((call) => call.url === '/turn');
      const postCalls = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCalls).toHaveLength(turnCalls.length);
      expect(turnCalls[turnCalls.length - 1].body).toEqual(expect.objectContaining({
        text: question,
        useModel: false,
        modelProvider: 'openai_responses',
        modelName: 'gpt-5.5',
      }));
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        'Mira. Deterministic local turn.',
      ]);
      expect(harness.elements.lastTurn.textContent).toBe('deterministic');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
    expect(harness.calls.filter((call) => call.url === '/turn')).toHaveLength(2);
  });

  test('does not hijack generic proof instructions from explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    for (const question of [
      'please prove this Mission Control fixture',
      'summarize the proof with the runtime fixture',
    ]) {
      harness.elements.turnText.value = question;
      const submitEvent = { preventDefault: jest.fn() };
      await harness.elements.turnForm.listeners.submit(submitEvent);

      const turnCalls = harness.calls.filter((call) => call.url === '/turn');
      const postCalls = harness.calls.filter((call) => call.method === 'POST');
      expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(postCalls).toHaveLength(turnCalls.length);
      expect(turnCalls[turnCalls.length - 1].body).toEqual(expect.objectContaining({
        text: question,
        useModel: false,
        modelProvider: 'openai_responses',
        modelName: 'gpt-5.5',
      }));
      expect(harness.elements.thread.children.slice(-2).map((node) => node.children[0].textContent)).toEqual([
        question,
        'Mira. Deterministic local turn.',
      ]);
      expect(harness.elements.lastTurn.textContent).toBe('deterministic');
      expect(harness.elements.sendButton.disabled).toBe(false);
      expect(harness.elements.sendButton.textContent).toBe('Send');
    }
    expect(harness.calls.filter((call) => call.url === '/turn')).toHaveLength(2);
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
