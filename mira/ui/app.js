'use strict';

const state = {
  sessionId: `mira-ui-${Date.now()}`,
  turnCounter: 0,
  selectedModel: null,
  selectedTaskToken: null,
  workDraftCount: 0,
  workPendingCount: 0,
  workReviewedCount: 0,
  workReadyCount: 0,
  workSendPacketCount: 0,
  workSendConfirmationCount: 0,
  workSendCheckCount: 0,
  missionControlRoutePreviewCount: 0,
  missionControlRouteRequestCount: 0,
  missionControlContinuationCount: 0,
  missionControlFollowThroughCount: 0,
  missionControlDeliveryPreviewCount: 0,
  missionControlDispatchReadinessCount: 0,
  missionControlInternalSendDryRunCount: 0,
  missionControlInternalSendActivationDesignCount: 0,
  missionControlInternalSendActivationRequestCount: 0,
  selectedRouteRequestToken: null,
  queuedOwnedWorkCount: 0,
  missionControl: null,
  autonomyQueueCount: 0,
  autonomyFollowThroughCount: 0,
  autonomyLoopLabel: 'waiting',
};

const elements = {
  form: document.getElementById('turnForm'),
  text: document.getElementById('turnText'),
  useModel: document.getElementById('useModel'),
  modelProviderSelect: document.getElementById('modelProviderSelect'),
  draftButton: document.getElementById('draftButton'),
  sendButton: document.getElementById('sendButton'),
  thread: document.getElementById('thread'),
  statusStrip: document.getElementById('statusStrip'),
  contextToggle: document.getElementById('contextToggle'),
  contextPanel: document.getElementById('contextPanel'),
  brainLine: document.getElementById('brainLine'),
  modelPill: document.getElementById('modelPill'),
  projectSummary: document.getElementById('projectSummary'),
  missionAnswer: document.getElementById('missionAnswer'),
  coordinationDraftList: document.getElementById('coordinationDraftList'),
  routePreviewSummary: document.getElementById('routePreviewSummary'),
  saveRoutePreviewButton: document.getElementById('saveRoutePreviewButton'),
  routePreviewHistoryList: document.getElementById('routePreviewHistoryList'),
  routeRequestList: document.getElementById('routeRequestList'),
  routeContinuationPanel: document.getElementById('routeContinuationPanel'),
  routeContinuationList: document.getElementById('routeContinuationList'),
  routeFollowThroughList: document.getElementById('routeFollowThroughList'),
  routeDeliveryPreviewList: document.getElementById('routeDeliveryPreviewList'),
  routeDispatchReadinessList: document.getElementById('routeDispatchReadinessList'),
  routeInternalSendDryRunList: document.getElementById('routeInternalSendDryRunList'),
  routeInternalSendActivationDesignList: document.getElementById('routeInternalSendActivationDesignList'),
  routeInternalSendActivationRequestList: document.getElementById('routeInternalSendActivationRequestList'),
  foundationSummary: document.getElementById('foundationSummary'),
  laneSummary: document.getElementById('laneSummary'),
  nextStepSummary: document.getElementById('nextStepSummary'),
  gitSummary: document.getElementById('gitSummary'),
  mapTruthSummary: document.getElementById('mapTruthSummary'),
  jamesNeedSummary: document.getElementById('jamesNeedSummary'),
  operatorSummary: document.getElementById('operatorSummary'),
  coreSummary: document.getElementById('coreSummary'),
  personaSummary: document.getElementById('personaSummary'),
  recentSummary: document.getElementById('recentSummary'),
  workSummary: document.getElementById('workSummary'),
  lastTurn: document.getElementById('lastTurn'),
  modelSummary: document.getElementById('modelSummary'),
  reviewSummary: document.getElementById('reviewSummary'),
  draftList: document.getElementById('draftList'),
  taskList: document.getElementById('taskList'),
  reviewPanel: document.getElementById('reviewPanel'),
  readyList: document.getElementById('readyList'),
  sendPacketList: document.getElementById('sendPacketList'),
  sendConfirmationList: document.getElementById('sendConfirmationList'),
  sendCheckList: document.getElementById('sendCheckList'),
  autonomyTickButton: document.getElementById('autonomyTickButton'),
  autonomyFollowButton: document.getElementById('autonomyFollowButton'),
  autonomyList: document.getElementById('autonomyList'),
  recentTurns: document.getElementById('recentTurns'),
};

let modelStatus = null;

function isMobileViewport() {
  return window.matchMedia('(max-width: 820px)').matches;
}

function syncWorkbenchForViewport() {
  if (!isMobileViewport()) {
    elements.contextPanel.hidden = false;
    elements.contextToggle.setAttribute('aria-expanded', 'true');
    return;
  }
  elements.contextPanel.hidden = true;
  elements.contextToggle.setAttribute('aria-expanded', 'false');
}

function setText(node, value) {
  node.textContent = value || '';
}

function renderChips(items) {
  elements.statusStrip.replaceChildren(...items.map((item) => {
    const chip = document.createElement('span');
    chip.className = `chip ${item.kind || ''}`.trim();
    chip.textContent = item.label;
    return chip;
  }));
}

function appendMessage(role, content, className = role) {
  const article = document.createElement('article');
  article.className = `message ${className}`;
  const body = document.createElement('p');
  body.textContent = content;
  article.append(body);
  elements.thread.append(article);
  elements.thread.scrollTop = elements.thread.scrollHeight;
  return article;
}

function summarizeOperator(context) {
  if (!context || context.loaded !== true) return 'Work context not loaded yet.';
  const lanes = Array.isArray(context.operatingLanes) ? context.operatingLanes.slice(0, 5).join(', ') : '';
  return lanes ? `Work she can reason about: ${lanes}.` : 'Work context loaded.';
}

function summarizeCore(payload) {
  const core = payload?.loadedCoreSummary;
  if (!core || core.available !== true) return 'Starter identity not loaded.';
  const persona = payload?.personaCore;
  const traits = Array.isArray(persona?.traits) ? persona.traits.slice(0, 4).join(', ') : 'present, direct';
  return `Starter identity loaded: ${traits}. External actions stay gated.`;
}

function summarizePersona(payload) {
  const persona = payload?.personaCore;
  if (!persona || persona.loaded !== true) return 'starter persona not loaded';
  const traits = Array.isArray(persona.traits) ? persona.traits.slice(0, 5).join(', ') : '';
  const style = Array.isArray(persona.style) ? persona.style.slice(0, 3).join(', ') : '';
  return `${persona.name || 'Mira'}: ${traits}${style ? ` | ${style}` : ''}`;
}

function updateRuntimeState(payload) {
  const stateFlags = payload?.state || {};
  const model = payload?.model || {};
  renderChips([
    { label: stateFlags.normalizedCoreLoaded ? 'core loaded' : 'core missing', kind: stateFlags.normalizedCoreLoaded ? 'good' : 'warn' },
    { label: payload?.operatorContext?.loaded ? 'operator loaded' : 'operator missing', kind: payload?.operatorContext?.loaded ? 'good' : 'warn' },
    modelStatus ? {
      label: modelStatus.available ? `${modelStatus.model} ready` : `${modelStatus.model} not ready`,
      kind: modelStatus.available ? 'good' : 'warn',
    } : { label: 'model unknown', kind: 'warn' },
    { label: model.requested ? (payload.modelInvoked ? `model ${model.model}` : 'model failed') : 'deterministic' },
  ]);
  setText(elements.operatorSummary, summarizeOperator(payload?.operatorContext));
  setText(elements.coreSummary, summarizeCore(payload));
  setText(elements.personaSummary, summarizePersona(payload));
  setText(elements.lastTurn, payload?.modelInvoked ? 'model-backed' : 'deterministic');
}

function findCapability(payload, id) {
  const capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities : [];
  return capabilities.find((capability) => capability?.id === id) || null;
}

function updateReadOnlyRuntimeState(sessionPayload, capabilitiesPayload) {
  const session = sessionPayload?.session || {};
  const acceptance = session.acceptanceContinuity || {};
  const normalizedCore = session.normalizedCore || {};
  const telegramRoute = findCapability(capabilitiesPayload, 'telegram_route');
  const stateRootReady = session.stateRootReady === true;
  const acceptanceCount = Number(acceptance.documentCount || 0);
  const coreCount = Number(normalizedCore.documentCount || 0);

  renderChips([
    { label: stateRootReady ? 'state root ready' : 'state root missing', kind: stateRootReady ? 'good' : 'warn' },
    { label: acceptance.loaded ? 'acceptance loaded' : 'acceptance missing', kind: acceptance.loaded ? 'good' : 'warn' },
    { label: normalizedCore.loaded ? 'core loaded' : 'core missing', kind: normalizedCore.loaded ? 'good' : 'warn' },
    modelStatus ? {
      label: modelStatus.available ? `${modelStatus.model} ready` : `${modelStatus.model} not ready`,
      kind: modelStatus.available ? 'good' : 'warn',
    } : { label: 'model unknown', kind: 'warn' },
    {
      label: telegramRoute?.status === 'blocked' ? 'channels gated' : 'channels checked',
      kind: telegramRoute?.status === 'blocked' ? 'warn' : 'good',
    },
  ]);

  setText(elements.operatorSummary, stateRootReady ? 'Local state root ready.' : 'Local state root not ready.');
  setText(
    elements.coreSummary,
    acceptance.loaded || normalizedCore.loaded
      ? `${acceptanceCount} acceptance docs and ${coreCount} core records available.`
      : 'Core state not loaded.',
  );
  setText(elements.personaSummary, 'Mira workbench ready.');
  setText(elements.lastTurn, 'no turn yet');
  setText(elements.recentSummary, 'not loaded on boot');
}

function renderCoordinationDrafts(drafts) {
  if (!Array.isArray(drafts) || drafts.length === 0) {
    elements.coordinationDraftList.textContent = 'no coordination preview yet';
    return;
  }

  const nodes = drafts.slice(0, 4).map((draft) => {
    const item = document.createElement('div');
    item.className = 'draft-item coordination-draft';

    const title = document.createElement('strong');
    title.textContent = `${draft.target || 'team'} · ${draft.purpose || 'next move'}`;

    const message = document.createElement('p');
    message.textContent = draft.message || '';

    item.append(title, message);
    return item;
  });
  elements.coordinationDraftList.replaceChildren(...nodes);
}

function isMissionControlQuestion(text) {
  return /what\s+(is\s+)?happening|what\s+happens?\s+next|what\s+should\s+happen\s+next|what\s+now|what\s+do\s+i\s+need\s+to\s+do/i.test(text);
}

function answerMissionControlQuestion() {
  const mission = state.missionControl;
  if (!mission?.answer) return false;
  appendMessage('mira', mission.answer, 'mira mission-answer');
  setText(elements.lastTurn, 'mission control local');
  return true;
}

function describeRoutePreview(preview) {
  if (!preview || preview.status !== 'reviewed_preview_only') {
    return 'Route preview: not prepared yet.';
  }
  const target = preview.selectedDraftTarget || preview.plan?.target?.role || 'team';
  const purpose = preview.selectedDraftPurpose || 'coordination';
  const audit = preview.audit || {};
  const manualState = preview.plan?.manualExecutionRequired === true ? 'manual execution required' : 'manual review required';
  const runtimeState = preview.plan?.runtimeExecutes === true || audit.runtimeExecutes === true ? 'runtime execution pending review' : 'no runtime execution';
  const sendState = audit.externalSend === true || audit.sendPerformed === true ? 'send pending review' : 'no external send';
  const routeState = audit.routeFlip === true ? 'route change pending review' : 'no route flip';
  const providerState = audit.providerInvoked === true ? 'provider pending review' : 'no provider';
  return `Route preview: ${target} · ${purpose} · ${preview.status.replace(/_/g, ' ')} · ${manualState} · ${runtimeState} · ${sendState} · ${routeState} · ${providerState}.`;
}

function updateSquidRunContext(payload) {
  if (!payload || payload.ok !== true) {
    setText(elements.projectSummary, 'SquidRun context unavailable');
    setText(elements.missionAnswer, 'Mission Control is waiting for local SquidRun evidence.');
    renderCoordinationDrafts([]);
    setText(elements.routePreviewSummary, 'Route preview: not prepared yet.');
    setText(elements.foundationSummary, 'No foundation evidence loaded.');
    setText(elements.laneSummary, 'No local project context loaded.');
    setText(elements.nextStepSummary, 'Open the current SquidRun lane.');
    setText(elements.gitSummary, 'Git status unavailable.');
    setText(elements.mapTruthSummary, 'System map unavailable.');
    setText(elements.jamesNeedSummary, 'James needed: no concrete setup step yet.');
    return;
  }

  const projectName = payload.project?.name || 'current project';
  const lane = payload.lane || {};
  const owned = payload.ownedWork || {};
  const git = payload.git || {};
  const dirtyWork = payload.dirtyWork || {};
  const systemMap = payload.systemMap || {};
  const roadmap = payload.roadmap || {};
  const summary = payload.summary || {};
  const mission = payload.missionControl || {};
  const laneLabel = lane.sourceRef || lane.status || 'local context';
  const objective = summary.happening || lane.objective || 'No active lane objective found.';
  const gitBranch = git.branch ? ` on ${git.branch}` : '';
  const dirtyText = git.loaded ? `${git.dirtyCount || 0} changed files${gitBranch}` : 'git status unavailable';
  state.queuedOwnedWorkCount = Number(owned.pendingCount || 0);
  state.missionControl = mission;

  setText(elements.projectSummary, `${projectName} · ${laneLabel}`);
  setText(elements.missionAnswer, mission.answer || 'Mission Control has no local answer yet.');
  renderCoordinationDrafts(mission.coordinationDrafts);
  setText(elements.routePreviewSummary, describeRoutePreview(mission.internalRoutePreview));
  setText(elements.foundationSummary, `Foundation vs product: ${mission.foundationVsProduct || 'Local context is foundation; Mission Control is the product test.'}`);
  setText(elements.laneSummary, `What is happening: ${objective}`);
  setText(elements.nextStepSummary, `Next here: ${summary.nextStep || 'No current local next step found.'}`);
  setText(elements.gitSummary, `Git: ${dirtyWork.summary || dirtyText}`);
  setText(elements.mapTruthSummary, `Map truth: ${roadmap.hardTruth || systemMap.truth || 'No system-map truth line found.'}`);
  setText(elements.jamesNeedSummary, `James needed: ${summary.jamesAction === 'DO THIS' ? 'yes' : 'no'} · ${summary.jamesActionReason || 'No James setup needed for local context.'}`);
  renderWorkSummary();
}

function updateModelChoices(payload) {
  if (!payload || !Array.isArray(payload.choices)) return;
  const options = payload.choices.map((choice) => {
    const option = document.createElement('option');
    option.value = choice.id;
    option.disabled = choice.selectable !== true;
    const status = choice.available ? 'ready' : choice.runtimeAdapterReady ? 'not ready' : 'not wired';
    option.textContent = `${choice.label}${choice.model ? `: ${choice.model}` : ''} (${status})`;
    option.dataset.provider = choice.provider;
    option.dataset.model = choice.model || '';
    return option;
  });
  elements.modelProviderSelect.replaceChildren(...options);
  const selected = payload.choices.find((choice) => choice.provider === payload.selectedProvider && choice.selectable)
    || payload.choices.find((choice) => choice.selectable);
  if (selected) {
    state.selectedModel = selected;
    elements.modelProviderSelect.value = selected.id;
  }
}

function updateModelSummary(payload) {
  modelStatus = payload || null;
  if (!payload) {
    document.body.dataset.modelReady = 'false';
    setText(elements.brainLine, 'model unknown');
    setText(elements.modelPill, 'model unknown');
    setText(elements.modelSummary, 'unknown');
    return;
  }
  const state = payload.available ? 'ready' : 'not ready';
  const provider = payload.selectedProvider === 'ollama_chat' ? 'Gemma/Ollama' : 'OpenAI';
  document.body.dataset.modelReady = payload.available ? 'true' : 'false';
  setText(elements.brainLine, `${provider}: ${payload.model} ${state}`);
  setText(elements.modelPill, payload.available ? payload.model : 'model not ready');
  setText(elements.modelSummary, `${provider} ${state}: ${payload.model}. ${payload.nextLocalModelStep || ''}`.trim());
}

function updateReviewSummary(payload) {
  const count = Number(payload?.pending_count || 0);
  setText(elements.reviewSummary, count === 1 ? '1 pending correction' : `${count} pending corrections`);
}

function formatReviewStamp(value) {
  if (!value) return 'pending review';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'pending review';
  return `pending review · ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function formatReadyStamp(value) {
  if (!value) return 'ready';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'ready';
  return `ready · ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function formatLoopStamp(value) {
  if (!value) return 'waiting';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'waiting';
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function cleanPreviewText(value) {
  const frontMatterKey = /^(schema|id|kind|status|created_at|source|session_id|message_id|source_draft_id|source_draft_relative_path|source_draft_sha256|external_send|crm_mutation|runtime_executes_external_action|review_required):\s*/i;
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line === '---') return false;
      if (/^#{1,6}\s+/.test(line)) return false;
      if (frontMatterKey.test(line)) return false;
      if (/^-\s*(id|path|sha256):\s*/i.test(line)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function appendPreviewLine(container, label, value) {
  const cleaned = cleanPreviewText(value);
  if (!cleaned) return;
  const paragraph = document.createElement('p');
  paragraph.textContent = label ? `${label}: ${cleaned}` : cleaned;
  container.append(paragraph);
}

function renderWorkSummary() {
  const queued = state.queuedOwnedWorkCount > 0 ? ` / ${state.queuedOwnedWorkCount} queued` : '';
  setText(elements.workSummary, `${state.workDraftCount} drafts / ${state.workPendingCount} pending / ${state.workReviewedCount} reviewed / ${state.workReadyCount} ready / ${state.workSendPacketCount} not sent / ${state.workSendConfirmationCount} confirmed / ${state.workSendCheckCount} checked / ${state.missionControlRoutePreviewCount} route previews / ${state.missionControlRouteRequestCount} route review items / ${state.missionControlContinuationCount} continuations / ${state.missionControlFollowThroughCount} team recommendations / ${state.missionControlDeliveryPreviewCount} delivery previews / ${state.missionControlDispatchReadinessCount} dispatch checklists / ${state.missionControlInternalSendDryRunCount} send dry runs / ${state.missionControlInternalSendActivationDesignCount} activation designs / ${state.missionControlInternalSendActivationRequestCount} activation requests / ${state.autonomyQueueCount} next moves / ${state.autonomyFollowThroughCount} followed${queued}`);
}

function updateDraftList(payload) {
  const drafts = Array.isArray(payload?.drafts) ? payload.drafts : [];
  state.workDraftCount = drafts.length;
  renderWorkSummary();
  if (drafts.length === 0) {
    setText(elements.draftList, 'none yet');
    return;
  }
  elements.draftList.replaceChildren(...drafts.slice(0, 5).map((draft) => {
    const item = document.createElement('article');
    item.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = cleanPreviewText(draft.displayTitle) || 'Customer reply';
    const meta = document.createElement('span');
    meta.textContent = formatReviewStamp(draft.createdAt);
    item.append(title, meta);
    appendPreviewLine(item, 'Request', draft.requestPreview || draft.preview);
    appendPreviewLine(item, 'Draft', draft.draftPreview);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'subtle-button';
    action.textContent = 'task';
    action.addEventListener('click', async () => {
      action.disabled = true;
      action.textContent = 'making';
      try {
        await createTaskFromDraft(draft);
        appendMessage('mira', 'Task saved for review.');
        await refreshTasks();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
        action.disabled = false;
        action.textContent = 'task';
      }
    });
    item.append(action);
    return item;
  }));
}

function updateTaskList(payload) {
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const pending = Number(payload?.pendingCount || 0);
  const reviewed = Number(payload?.reviewedCount || 0);
  state.workPendingCount = pending;
  state.workReviewedCount = reviewed;
  renderWorkSummary();
  if (tasks.length === 0) {
    setText(elements.taskList, 'none yet');
    renderReviewPanel(null);
    return;
  }
  elements.taskList.replaceChildren(...tasks.slice(0, 5).map((task) => {
    const item = document.createElement('article');
    item.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = cleanPreviewText(task.displayTitle) || 'Review task';
    const source = document.createElement('span');
    source.textContent = `${String(task.status || 'pending_review').replace(/_/g, ' ')} · ${task.sourceDraftLinked ? 'draft linked' : 'draft missing'}`;
    item.append(title, source);
    appendPreviewLine(item, 'Task', task.taskPreview || task.preview);
    appendPreviewLine(item, 'Checklist', task.checklistPreview);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'subtle-button';
    action.textContent = state.selectedTaskToken === task.actionToken ? 'open' : 'review';
    action.addEventListener('click', async () => {
      state.selectedTaskToken = task.actionToken;
      action.disabled = true;
      action.textContent = 'opening';
      try {
        const detail = await fetchTaskReview(task.actionToken);
        renderReviewPanel(detail);
      } catch (error) {
        appendMessage('mira', error.message, 'error');
      } finally {
        action.disabled = false;
        action.textContent = 'open';
      }
    });
    item.append(action);
    return item;
  }));
}

function renderReviewPanel(detail) {
  if (!detail || detail.ok !== true) {
    setText(elements.reviewPanel, 'choose a task');
    return;
  }
  elements.reviewPanel.replaceChildren();
  const task = detail.task || {};
  const linkedDraft = detail.linkedDraft || {};
  const heading = document.createElement('strong');
  heading.textContent = `${cleanPreviewText(task.displayTitle) || 'Review task'} · ${String(task.status || 'pending_review').replace(/_/g, ' ')}`;
  const request = document.createElement('p');
  request.textContent = `Request: ${cleanPreviewText(linkedDraft.requestPreview || task.taskPreview || task.preview)}`;
  const label = document.createElement('label');
  label.className = 'review-editor-label';
  label.textContent = 'Draft';
  const textarea = document.createElement('textarea');
  textarea.className = 'review-editor';
  textarea.rows = 8;
  textarea.value = linkedDraft.editableDraft || linkedDraft.draftPreview || '';
  const note = document.createElement('input');
  note.className = 'review-note';
  note.placeholder = 'note for review record';
  const actions = document.createElement('div');
  actions.className = 'review-actions';
  const buttons = [
    ['approve', 'Approve'],
    ['edit', 'Save edit'],
    ['reject', 'Reject'],
  ].map(([decision, text]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = decision === 'reject' ? 'subtle-button danger-button' : 'subtle-button';
    button.textContent = text;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await submitTaskReview({
          taskToken: task.actionToken,
          decision,
          editedDraftText: textarea.value,
          note: note.value,
        });
        appendMessage('mira', `Review saved: ${result.review.status}.`);
        if (result.review.status === 'approved' || result.review.status === 'edited') {
          await createReadyPackage({
            taskToken: task.actionToken,
            reviewToken: result.review.reviewToken,
          });
          appendMessage('mira', 'Ready reply saved locally.');
          await refreshReadyPackages();
        }
        const refreshed = await fetchTaskReview(task.actionToken);
        renderReviewPanel(refreshed);
        await refreshTasks();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
    return button;
  });
  actions.append(...buttons);
  elements.reviewPanel.append(heading, request, label, textarea, note, actions);
  if (detail.ready?.ready) {
    renderReadyPackageInline(detail.ready.ready);
  }
}

function renderReadyPackageInline(ready) {
  const readyBlock = document.createElement('div');
  readyBlock.className = 'ready-inline';
  const label = document.createElement('strong');
  label.textContent = 'Ready reply';
  const reply = document.createElement('textarea');
  reply.className = 'review-editor';
  reply.rows = 6;
  reply.readOnly = true;
  reply.value = ready.finalReplyText || '';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'subtle-button';
  copy.textContent = 'Copy text';
  copy.addEventListener('click', async () => {
    await copyTextToClipboard(ready.finalReplyText || '');
    copy.textContent = 'Copied';
  });
  readyBlock.append(label, reply, copy);
  elements.reviewPanel.append(readyBlock);
}

function updateReadyList(payload) {
  const ready = Array.isArray(payload?.ready) ? payload.ready : [];
  state.workReadyCount = Number(payload?.readyCount || ready.length || 0);
  renderWorkSummary();
  if (ready.length === 0) {
    setText(elements.readyList, 'none yet');
    return;
  }
  elements.readyList.replaceChildren(...ready.slice(0, 5).map((item) => {
    const card = document.createElement('article');
    card.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = cleanPreviewText(item.displayTitle) || 'Ready reply';
    const meta = document.createElement('span');
    meta.textContent = `${String(item.status || 'ready_to_send').replace(/_/g, ' ')} · ${formatReadyStamp(item.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Reply', item.finalReplyText);
    const recipient = document.createElement('input');
    recipient.className = 'review-note';
    recipient.placeholder = 'recipient';
    const channel = document.createElement('select');
    channel.className = 'review-note';
    [
      ['email', 'Email'],
      ['sms', 'SMS'],
      ['manual', 'Manual'],
      ['other', 'Other'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      channel.append(option);
    });
    const prepare = document.createElement('button');
    prepare.type = 'button';
    prepare.className = 'subtle-button';
    prepare.textContent = 'Prepare send packet';
    prepare.addEventListener('click', async () => {
      prepare.disabled = true;
      try {
        await createSendPacket({
          readyToken: item.token,
          recipient: recipient.value,
          channel: channel.value,
        });
        prepare.textContent = 'Prepared';
        await refreshSendPackets();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
        prepare.disabled = false;
      }
    });
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'subtle-button';
    copy.textContent = 'Copy text';
    copy.addEventListener('click', async () => {
      await copyTextToClipboard(item.finalReplyText || '');
      copy.textContent = 'Copied';
    });
    card.append(recipient, channel, prepare, copy);
    return card;
  }));
}

function updateSendPacketList(payload) {
  const packets = Array.isArray(payload?.packets) ? payload.packets : [];
  state.workSendPacketCount = Number(payload?.packetCount || packets.length || 0);
  renderWorkSummary();
  if (packets.length === 0) {
    setText(elements.sendPacketList, 'none yet');
    return;
  }
  elements.sendPacketList.replaceChildren(...packets.slice(0, 5).map((packet) => {
    const card = document.createElement('article');
    card.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = cleanPreviewText(packet.displayTitle) || 'Send packet';
    const meta = document.createElement('span');
    meta.textContent = `not sent · ${String(packet.channel || 'channel')} · ${formatReadyStamp(packet.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Recipient', packet.recipient);
    appendPreviewLine(card, 'Reply', packet.finalReplyText);
    const confirmText = document.createElement('input');
    confirmText.className = 'review-note';
    confirmText.placeholder = 'type confirmation note';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'subtle-button';
    confirm.textContent = 'Confirm manually';
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        await createSendConfirmation({
          packetToken: packet.token,
          confirmText: confirmText.value || 'Confirmed for manual send review.',
        });
        confirm.textContent = 'Confirmed';
        await refreshSendConfirmations();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
        confirm.disabled = false;
      }
    });
    const copyRecipient = document.createElement('button');
    copyRecipient.type = 'button';
    copyRecipient.className = 'subtle-button';
    copyRecipient.textContent = 'Copy recipient';
    copyRecipient.addEventListener('click', async () => {
      await copyTextToClipboard(packet.recipient || '');
      copyRecipient.textContent = 'Copied';
    });
    const copyReply = document.createElement('button');
    copyReply.type = 'button';
    copyReply.className = 'subtle-button';
    copyReply.textContent = 'Copy text';
    copyReply.addEventListener('click', async () => {
      await copyTextToClipboard(packet.finalReplyText || '');
      copyReply.textContent = 'Copied';
    });
    card.append(confirmText, confirm, copyRecipient, copyReply);
    return card;
  }));
}

function updateSendConfirmationList(payload) {
  const confirmations = Array.isArray(payload?.confirmations) ? payload.confirmations : [];
  state.workSendConfirmationCount = Number(payload?.confirmationCount || confirmations.length || 0);
  renderWorkSummary();
  if (confirmations.length === 0) {
    setText(elements.sendConfirmationList, 'none yet');
    return;
  }
  elements.sendConfirmationList.replaceChildren(...confirmations.slice(0, 5).map((confirmation) => {
    const card = document.createElement('article');
    card.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = cleanPreviewText(confirmation.displayTitle) || 'Manual confirmation';
    const meta = document.createElement('span');
    meta.textContent = `confirmed manually · not sent · ${String(confirmation.channel || 'channel')} · ${formatReadyStamp(confirmation.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Recipient', confirmation.recipient);
    appendPreviewLine(card, 'Confirmation', confirmation.confirmText);
    appendPreviewLine(card, 'Reply', confirmation.finalReplyText);
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'subtle-button';
    check.textContent = 'Run pre-send check';
    check.addEventListener('click', async () => {
      check.disabled = true;
      try {
        await createSendCheck({ confirmationToken: confirmation.token });
        check.textContent = 'Checked';
        await refreshSendChecks();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
        check.disabled = false;
      }
    });
    card.append(check);
    return card;
  }));
}

function updateSendCheckList(payload) {
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  state.workSendCheckCount = Number(payload?.checkCount || checks.length || 0);
  renderWorkSummary();
  if (checks.length === 0) {
    setText(elements.sendCheckList, 'none yet');
    return;
  }
  elements.sendCheckList.replaceChildren(...checks.slice(0, 5).map((check) => {
    const card = document.createElement('article');
    card.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = cleanPreviewText(check.displayTitle) || (check.status === 'ready_for_manual_send' ? 'Looks ready to send manually' : 'Fix before sending');
    const meta = document.createElement('span');
    const status = check.status === 'ready_for_manual_send' ? 'Looks ready to send manually' : 'Fix before sending';
    meta.textContent = `${status} · still not sent · ${String(check.channel || 'channel')} · ${formatReadyStamp(check.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Recipient', check.recipient);
    appendPreviewLine(card, 'Original request', check.originalRequest);
    appendPreviewLine(card, 'Notes', Array.isArray(check.notes) ? check.notes.join(' ') : '');
    if (Array.isArray(check.checklist) && check.checklist.length > 0) {
      appendPreviewLine(card, 'Checklist', check.checklist.map((item) => `${item.ok ? 'ok' : 'fix'}: ${item.label}`).join('; '));
    }
    appendPreviewLine(card, 'Reply', check.finalReplyText);
    return card;
  }));
}

function updateRoutePreviewHistoryList(payload) {
  const previews = Array.isArray(payload?.previews) ? payload.previews : [];
  state.missionControlRoutePreviewCount = Number(payload?.previewCount || previews.length || 0);
  renderWorkSummary();
  if (previews.length === 0) {
    setText(elements.routePreviewHistoryList, 'no saved route previews yet');
    return;
  }

  elements.routePreviewHistoryList.replaceChildren(...previews.slice(0, 5).map((preview) => {
    const card = document.createElement('article');
    card.className = 'draft-item route-preview-history';
    const title = document.createElement('strong');
    title.textContent = `${preview.targetRole || 'team'} · ${preview.purpose || 'coordination'}`;
    const meta = document.createElement('span');
    meta.textContent = `${String(preview.status || 'pending_internal_review').replace(/_/g, ' ')} · manual execution required · not sent · ${formatReadyStamp(preview.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Preview', preview.contentPreview || preview.content);
    appendPreviewLine(card, 'Audit', 'internal review only; no runtime execution, external send, route flip, provider, account or token access, or live hm-send.');
    const promote = document.createElement('button');
    promote.type = 'button';
    promote.className = 'subtle-button';
    promote.textContent = 'Make review item';
    promote.addEventListener('click', async () => {
      promote.disabled = true;
      promote.textContent = 'Making';
      try {
        await createRouteRequestFromPreview(preview);
        promote.textContent = 'Review item made';
        appendMessage('mira', 'Route review item saved locally. Nothing was sent or executed.');
        await refreshRouteRequests();
        await refreshRouteContinuations();
        await refreshRouteFollowThroughRecommendations();
        await refreshRouteDeliveryPreviews();
        await refreshDispatchReadiness();
        await refreshInternalSendDryRuns();
        await refreshInternalSendActivationDesigns();
        await refreshInternalSendActivationRequests();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
        promote.disabled = false;
        promote.textContent = 'Make review item';
      }
    });
    card.append(promote);
    return card;
  }));
}

function updateRouteRequestList(payload) {
  const requests = Array.isArray(payload?.requests) ? payload.requests : [];
  state.missionControlRouteRequestCount = Number(payload?.requestCount || requests.length || 0);
  renderWorkSummary();
  if (requests.length === 0) {
    setText(elements.routeRequestList, 'no route review items yet');
    if (!state.selectedRouteRequestToken) {
      renderRouteContinuationPanel(null);
    }
    return;
  }

  elements.routeRequestList.replaceChildren(...requests.slice(0, 5).map((request) => {
    const card = document.createElement('article');
    card.className = 'draft-item route-request-history';
    const title = document.createElement('strong');
    title.textContent = `${request.targetRole || 'team'} · ${request.purpose || 'coordination'} review item`;
    const meta = document.createElement('span');
    meta.textContent = `${String(request.status || 'pending_internal_review').replace(/_/g, ' ')} · manual execution required · not sent · ${formatReadyStamp(request.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Request', request.contentPreview || request.content);
    appendPreviewLine(card, 'Audit', 'reviewable owned work only; no command stored, runtime execution, external send, route flip, provider, account or token access, or live hm-send.');
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'subtle-button';
    action.textContent = state.selectedRouteRequestToken === request.actionToken ? 'selected' : 'review continuation';
    action.addEventListener('click', () => {
      state.selectedRouteRequestToken = request.actionToken;
      renderRouteContinuationPanel(request);
      updateRouteRequestList(payload);
    });
    card.append(action);
    return card;
  }));
  if (state.selectedRouteRequestToken) {
    const selected = requests.find((request) => request.actionToken === state.selectedRouteRequestToken);
    renderRouteContinuationPanel(selected || null);
  }
}

function renderRouteContinuationPanel(request) {
  if (!request) {
    setText(elements.routeContinuationPanel, 'choose a route review item');
    return;
  }

  elements.routeContinuationPanel.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = `${request.targetRole || 'team'} · ${request.purpose || 'coordination'} continuation`;

  const requestText = document.createElement('p');
  requestText.textContent = cleanPreviewText(request.contentPreview || request.content);

  const label = document.createElement('label');
  label.className = 'review-editor-label';
  label.textContent = 'Continuation text';

  const textarea = document.createElement('textarea');
  textarea.className = 'review-editor';
  textarea.rows = 5;
  textarea.value = cleanPreviewText(request.content || request.contentPreview);

  const note = document.createElement('input');
  note.className = 'review-note';
  note.type = 'text';
  note.placeholder = 'Review note';

  const actions = document.createElement('div');
  actions.className = 'review-actions';
  [
    ['approve', 'Approve'],
    ['edit', 'Save edit'],
    ['reject', 'Reject'],
  ].forEach(([decision, labelText]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = decision === 'reject' ? 'subtle-button danger-button' : 'subtle-button';
    button.textContent = labelText;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const payload = await createOwnedWorkContinuation({
          requestToken: request.actionToken,
          decision,
          editedContent: textarea.value,
          note: note.value,
        });
        appendMessage('mira', `${payload.continuation.decision} continuation metadata saved locally. Nothing was sent or executed.`);
        await refreshRouteContinuations();
        await refreshRouteFollowThroughRecommendations();
        await refreshRouteDeliveryPreviews();
        await refreshDispatchReadiness();
        await refreshInternalSendDryRuns();
        await refreshInternalSendActivationDesigns();
        await refreshInternalSendActivationRequests();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
    actions.append(button);
  });

  const audit = document.createElement('p');
  audit.textContent = 'Review-only continuation; no command stored, runtime execution, external send, route flip, provider, account or token access, or live hm-send.';

  elements.routeContinuationPanel.append(heading, requestText, label, textarea, note, actions, audit);
}

function updateRouteContinuationList(payload) {
  const continuations = Array.isArray(payload?.continuations) ? payload.continuations : [];
  state.missionControlContinuationCount = Number(payload?.continuationCount || continuations.length || 0);
  renderWorkSummary();
  if (continuations.length === 0) {
    setText(elements.routeContinuationList, 'no owned-work continuations yet');
    return;
  }

  elements.routeContinuationList.replaceChildren(...continuations.slice(0, 5).map((continuation) => {
    const card = document.createElement('article');
    card.className = 'draft-item route-continuation-history';
    const title = document.createElement('strong');
    title.textContent = `${continuation.targetRole || 'team'} · ${continuation.decision || 'review'} continuation`;
    const meta = document.createElement('span');
    meta.textContent = `${String(continuation.status || 'pending_internal_review').replace(/_/g, ' ')} · manual execution required · not sent · ${formatReadyStamp(continuation.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Continuation', continuation.contentPreview || continuation.content);
    appendPreviewLine(card, 'Note', continuation.note);
    appendPreviewLine(card, 'Audit', 'owned-work continuation only; no command stored, runtime execution, external send, route flip, provider, account or token access, or live hm-send.');
    return card;
  }));
}

function updateRouteFollowThroughList(payload) {
  const recommendations = Array.isArray(payload?.recommendations) ? payload.recommendations : [];
  const selected = payload?.selectedRecommendation || recommendations.find((recommendation) => recommendation?.selected === true) || null;
  state.missionControlFollowThroughCount = Number(payload?.recommendationCount || recommendations.length || 0);
  renderWorkSummary();
  if (recommendations.length === 0) {
    setText(elements.routeFollowThroughList, 'no follow-through recommendation yet');
    return;
  }

  const ordered = selected
    ? [selected, ...recommendations.filter((recommendation) => recommendation.id !== selected.id)]
    : recommendations;
  elements.routeFollowThroughList.replaceChildren(...ordered.slice(0, 5).map((recommendation) => {
    const card = document.createElement('article');
    card.className = `draft-item route-follow-through${recommendation.selected ? ' selected' : ''}`;
    const title = document.createElement('strong');
    title.textContent = recommendation.selected
      ? `Selected next internal move: ${recommendation.targetRole || 'team'}`
      : `${recommendation.targetRole || 'team'} · ${String(recommendation.status || 'available_for_internal_review').replace(/_/g, ' ')}`;
    const meta = document.createElement('span');
    meta.textContent = `${String(recommendation.status || 'available_for_internal_review').replace(/_/g, ' ')} · review-only selector · manual execution required · not sent · ${formatReadyStamp(recommendation.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Next move', recommendation.nextTeamMove);
    appendPreviewLine(card, 'Source continuation', `${recommendation.sourceContinuationDecision || 'review'} · ${String(recommendation.sourceContinuationStatus || '').replace(/_/g, ' ')}`);
    appendPreviewLine(card, 'Reason', recommendation.selectorReason);
    appendPreviewLine(card, 'Audit', 'recommendation only; no command stored, runtime execution, external send, route flip, provider, account or token access, Telegram, or live hm-send.');
    if (recommendation.selected === true) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'subtle-button';
      action.textContent = 'Preview delivery packet';
      action.addEventListener('click', async () => {
        action.disabled = true;
        action.textContent = 'Previewing';
        try {
          await createInternalDeliveryPreview(recommendation);
          action.textContent = 'Preview saved';
          appendMessage('mira', 'Internal delivery preview saved locally. Nothing was sent or executed.');
          await refreshRouteDeliveryPreviews();
          await refreshDispatchReadiness();
          await refreshInternalSendDryRuns();
          await refreshInternalSendActivationDesigns();
          await refreshInternalSendActivationRequests();
        } catch (error) {
          appendMessage('mira', error.message, 'error');
          action.disabled = false;
          action.textContent = 'Preview delivery packet';
        }
      });
      card.append(action);
    }
    return card;
  }));
}

function updateRouteDeliveryPreviewList(payload) {
  const previews = Array.isArray(payload?.previews) ? payload.previews : [];
  state.missionControlDeliveryPreviewCount = Number(payload?.previewCount || previews.length || 0);
  renderWorkSummary();
  if (previews.length === 0) {
    setText(elements.routeDeliveryPreviewList, 'no internal delivery previews yet');
    return;
  }

  elements.routeDeliveryPreviewList.replaceChildren(...previews.slice(0, 5).map((preview) => {
    const card = document.createElement('article');
    card.className = 'draft-item route-delivery-preview';
    const title = document.createElement('strong');
    title.textContent = `${preview.targetRole || 'team'} · delivery preview`;
    const meta = document.createElement('span');
    meta.textContent = `${String(preview.status || 'reviewed_preview_only').replace(/_/g, ' ')} · preview/audit only · manual execution required · not sent · ${formatReadyStamp(preview.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Pane target', `${preview.targetRole || 'team'} pane ${preview.targetPaneId || '?'}`);
    appendPreviewLine(card, 'Body', preview.deliveryPacket?.body?.content || preview.contentPreview || preview.content);
    appendPreviewLine(card, 'Checksum', preview.reviewDetails?.packetSha256);
    appendPreviewLine(card, 'Review', preview.reviewDetails?.copyInstruction);
    appendPreviewLine(card, 'Next move', preview.nextTeamMove);
    appendPreviewLine(card, 'Audit', 'preview packet only; no command stored, runtime execution, external send, route flip, provider/model call, account or token access, Telegram, or live hm-send.');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'subtle-button';
    copy.textContent = 'Copy packet body';
    copy.addEventListener('click', async () => {
      await copyTextToClipboard(preview.reviewDetails?.copyText || preview.deliveryPacket?.body?.content || preview.content || '');
      copy.textContent = 'Copied body';
    });
    const readiness = document.createElement('button');
    readiness.type = 'button';
    readiness.className = 'subtle-button';
    readiness.textContent = 'Review dispatch readiness';
    readiness.addEventListener('click', async () => {
      readiness.disabled = true;
      readiness.textContent = 'Checking readiness';
      try {
        await createDispatchReadiness(preview);
        readiness.textContent = 'Readiness saved';
        appendMessage('mira', 'Dispatch-readiness checklist saved locally. Nothing was sent or executed.');
        await refreshDispatchReadiness();
        await refreshInternalSendDryRuns();
        await refreshInternalSendActivationDesigns();
        await refreshInternalSendActivationRequests();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
        readiness.disabled = false;
        readiness.textContent = 'Review dispatch readiness';
      }
    });
    card.append(copy, readiness);
    return card;
  }));
}

function updateDispatchReadinessList(payload) {
  const readiness = Array.isArray(payload?.readiness) ? payload.readiness : [];
  state.missionControlDispatchReadinessCount = Number(payload?.readinessCount || readiness.length || 0);
  renderWorkSummary();
  if (readiness.length === 0) {
    setText(elements.routeDispatchReadinessList, 'no dispatch-readiness checklists yet');
    return;
  }

  elements.routeDispatchReadinessList.replaceChildren(...readiness.slice(0, 5).map((item) => {
    const card = document.createElement('article');
    card.className = 'draft-item route-dispatch-readiness';
    const title = document.createElement('strong');
    title.textContent = `${item.targetRole || 'team'} · dispatch readiness`;
    const meta = document.createElement('span');
    meta.textContent = `${String(item.status || 'ready_for_manual_dispatch_review').replace(/_/g, ' ')} · review/checklist only · manual execution required · not sent · ${formatReadyStamp(item.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Pane target', item.targetLabel || `${item.targetRole || 'team'} pane ${item.targetPaneId || '?'}`);
    appendPreviewLine(card, 'Copied body', item.copiedPaneMessage?.body || item.contentPreview || item.content);
    appendPreviewLine(card, 'Body checksum', item.bodySha256);
    appendPreviewLine(card, 'Packet checksum', item.packetSha256);
    appendPreviewLine(card, 'Checksum match', item.checksumMatched === true ? 'yes' : 'no');
    const checklist = Array.isArray(item.checklist)
      ? item.checklist.filter((entry) => entry?.ok === true).map((entry) => entry.label).join(' / ')
      : '';
    appendPreviewLine(card, 'Checklist', checklist);
    appendPreviewLine(card, 'Audit', 'readiness checklist only; no command stored, hm-send execution, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery.');
    const dryRun = document.createElement('button');
    dryRun.type = 'button';
    dryRun.className = 'subtle-button';
    dryRun.textContent = 'Create send dry run';
    dryRun.addEventListener('click', async () => {
      dryRun.disabled = true;
      dryRun.textContent = 'Creating dry run';
      try {
        await createInternalSendDryRun(item);
        dryRun.textContent = 'Dry run saved';
        appendMessage('mira', 'Internal-send dry-run audit saved locally. Nothing was sent or executed.');
        await refreshInternalSendDryRuns();
        await refreshInternalSendActivationDesigns();
        await refreshInternalSendActivationRequests();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
        dryRun.disabled = false;
        dryRun.textContent = 'Create send dry run';
      }
    });
    card.append(dryRun);
    return card;
  }));
}

function updateInternalSendDryRunList(payload) {
  const dryRuns = Array.isArray(payload?.dryRuns) ? payload.dryRuns : [];
  state.missionControlInternalSendDryRunCount = Number(payload?.dryRunCount || dryRuns.length || 0);
  renderWorkSummary();
  if (dryRuns.length === 0) {
    setText(elements.routeInternalSendDryRunList, 'no internal-send dry runs yet');
    return;
  }

  elements.routeInternalSendDryRunList.replaceChildren(...dryRuns.slice(0, 5).map((dryRun) => {
    const card = document.createElement('article');
    card.className = 'draft-item route-internal-send-dry-run';
    const title = document.createElement('strong');
    title.textContent = `${dryRun.targetRole || 'team'} · internal-send dry run`;
    const meta = document.createElement('span');
    meta.textContent = `${String(dryRun.status || 'dry_run_ready').replace(/_/g, ' ')} · adapter/audit only · manual execution required · not sent · ${formatReadyStamp(dryRun.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Pane target', dryRun.targetLabel || `${dryRun.targetRole || 'team'} pane ${dryRun.targetPaneId || '?'}`);
    appendPreviewLine(card, 'Body', dryRun.adapterDryRun?.body?.content || dryRun.contentPreview || dryRun.content);
    appendPreviewLine(card, 'Adapter', `${dryRun.adapterDryRun?.channel || 'hm-send'} dry-run via ${dryRun.adapterDryRun?.transport || 'ui/scripts/hm-send.js'}`);
    appendPreviewLine(card, 'Activation gate', dryRun.activationGate?.requiredReview || 'separate reviewed activation');
    appendPreviewLine(card, 'Audit', 'dry-run adapter/audit only; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery.');
    const design = document.createElement('button');
    design.type = 'button';
    design.className = 'subtle-button';
    design.textContent = 'Design activation proof';
    design.addEventListener('click', async () => {
      design.disabled = true;
      design.textContent = 'Designing activation';
      try {
        await createInternalSendActivationDesign(dryRun);
        design.textContent = 'Activation design saved';
        appendMessage('mira', 'Activation-design proof saved locally. Nothing was sent or executed.');
        await refreshInternalSendActivationDesigns();
        await refreshInternalSendActivationRequests();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
        design.disabled = false;
        design.textContent = 'Design activation proof';
      }
    });
    card.append(design);
    return card;
  }));
}

function updateInternalSendActivationDesignList(payload) {
  const designs = Array.isArray(payload?.designs) ? payload.designs : [];
  state.missionControlInternalSendActivationDesignCount = Number(payload?.designCount || designs.length || 0);
  renderWorkSummary();
  if (designs.length === 0) {
    setText(elements.routeInternalSendActivationDesignList, 'no activation designs yet');
    return;
  }

  elements.routeInternalSendActivationDesignList.replaceChildren(...designs.slice(0, 5).map((design) => {
    const card = document.createElement('article');
    card.className = 'draft-item route-internal-send-activation-design';
    const title = document.createElement('strong');
    title.textContent = `${design.targetRole || 'team'} · activation design`;
    const meta = document.createElement('span');
    meta.textContent = `${String(design.status || 'activation_design_review_only').replace(/_/g, ' ')} · refusal/rollback/audit required · manual execution required · not sent · ${formatReadyStamp(design.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Pane target', design.targetLabel || `${design.targetRole || 'team'} pane ${design.targetPaneId || '?'}`);
    appendPreviewLine(card, 'Body', design.contentPreview || design.content);
    appendPreviewLine(card, 'Activation gate', `${design.activationDesign?.requiredReview || 'separate_reviewed_activation'}; activation allowed: ${design.activationDesign?.activationAllowed === true ? 'yes' : 'no'}`);
    appendPreviewLine(card, 'Refusal', (design.refusalRequirements || []).map((item) => item.label).join(' / '));
    appendPreviewLine(card, 'Rollback', (design.rollbackRequirements || []).map((item) => item.label).join(' / '));
    appendPreviewLine(card, 'Audit', 'design/proof only; durable audit, refusal, and rollback requirements are visible; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery.');
    const request = document.createElement('button');
    request.type = 'button';
    request.className = 'subtle-button';
    request.textContent = 'Preview activation request';
    request.addEventListener('click', async () => {
      request.disabled = true;
      request.textContent = 'Previewing request';
      try {
        await createInternalSendActivationRequest(design);
        request.textContent = 'Activation request previewed';
        appendMessage('mira', 'Activation request preview saved locally. Nothing was sent or executed.');
        await refreshInternalSendActivationRequests();
      } catch (error) {
        appendMessage('mira', error.message, 'error');
        request.disabled = false;
        request.textContent = 'Preview activation request';
      }
    });
    card.append(request);
    return card;
  }));
}

function updateInternalSendActivationRequestList(payload) {
  const requests = Array.isArray(payload?.requests) ? payload.requests : [];
  state.missionControlInternalSendActivationRequestCount = Number(payload?.requestCount || requests.length || 0);
  renderWorkSummary();
  if (requests.length === 0) {
    setText(elements.routeInternalSendActivationRequestList, 'no activation requests yet');
    return;
  }

  elements.routeInternalSendActivationRequestList.replaceChildren(...requests.slice(0, 5).map((request) => {
    const card = document.createElement('article');
    card.className = 'draft-item route-internal-send-activation-request';
    const title = document.createElement('strong');
    title.textContent = `${request.targetRole || 'team'} · activation request preview`;
    const meta = document.createElement('span');
    meta.textContent = `${String(request.status || 'activation_request_review_only').replace(/_/g, ' ')} · reviewer/refusal/rollback/audit required · manual execution required · not sent · ${formatReadyStamp(request.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Pane target', request.targetLabel || `${request.targetRole || 'team'} pane ${request.targetPaneId || '?'}`);
    appendPreviewLine(card, 'Body', request.contentPreview || request.content);
    appendPreviewLine(card, 'Reviewer', `${request.reviewer?.reviewerRole || 'architect_or_oracle'} · ${String(request.reviewer?.status || 'pending_review').replace(/_/g, ' ')}`);
    appendPreviewLine(card, 'Activation request', `${request.activationRequest?.requiredReview || 'separate_reviewed_activation'}; activation allowed: ${request.activationRequest?.activationAllowed === true ? 'yes' : 'no'}`);
    appendPreviewLine(card, 'Refusal', (request.refusalPolicy || []).map((item) => item.label).join(' / '));
    appendPreviewLine(card, 'Rollback', (request.rollbackPlan || []).map((item) => item.label).join(' / '));
    appendPreviewLine(card, 'Audit', 'request preview only; reviewer, refusal, rollback, and audit fields are visible; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery.');
    return card;
  }));
}

function updateAutonomyList(payload) {
  const queue = Array.isArray(payload?.queue) ? payload.queue : [];
  const followThrough = Array.isArray(payload?.followThrough) ? payload.followThrough : [];
  const loop = payload?.loop && typeof payload.loop === 'object' ? payload.loop : null;
  state.autonomyQueueCount = Number(payload?.queueCount || queue.length || 0);
  state.autonomyFollowThroughCount = Number(payload?.followThroughCount || followThrough.length || 0);
  state.autonomyLoopLabel = loop?.status === 'ran' ? 'loop ran' : 'waiting';
  renderWorkSummary();

  const cards = [];
  if (loop && loop.status === 'ran') {
    const loopCard = document.createElement('article');
    loopCard.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = 'Loop';
    const meta = document.createElement('span');
    meta.textContent = `ran ${formatLoopStamp(loop.lastRunAt)} · next ${formatLoopStamp(loop.nextRunAt)}`;
    loopCard.append(title, meta);
    appendPreviewLine(loopCard, 'Made', `${Number(loop.tickCreatedCount || 0)} queue items, ${Number(loop.followCreatedCount || 0)} follow-through steps`);
    cards.push(loopCard);
  }
  if (payload?.brief?.available) {
    const brief = document.createElement('article');
    brief.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = cleanPreviewText(payload.brief.title) || 'Autonomy brief';
    brief.append(title);
    (payload.brief.lines || []).slice(0, 4).forEach((line) => appendPreviewLine(brief, null, line));
    cards.push(brief);
  }

  followThrough.slice(0, 5).forEach((item) => {
    const card = document.createElement('article');
    card.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = cleanPreviewText(item.resultTitle) || 'Follow-through';
    const meta = document.createElement('span');
    meta.textContent = `${String(item.status || 'local step').replace(/_/g, ' ')} · local only · ${formatReadyStamp(item.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Did', item.result);
    appendPreviewLine(card, 'Next', item.nextVisibleStep);
    if (Array.isArray(item.evidence)) {
      appendPreviewLine(card, 'Evidence', item.evidence.join(' '));
    }
    cards.push(card);
  });

  queue.slice(0, 5).forEach((item) => {
    const card = document.createElement('article');
    card.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = cleanPreviewText(item.title) || 'Next move';
    const meta = document.createElement('span');
    meta.textContent = `${String(item.status || 'pending')} · local only · ${formatReadyStamp(item.createdAt)}`;
    card.append(title, meta);
    appendPreviewLine(card, 'Why', item.reason);
    appendPreviewLine(card, 'Next', item.nextMove);
    appendPreviewLine(card, 'Mode', item.permissionUsed);
    cards.push(card);
  });

  if (cards.length === 0) {
    setText(elements.autonomyList, 'no next moves yet');
    return;
  }
  elements.autonomyList.replaceChildren(...cards);
}

function updateRecentTurns(payload) {
  const memory = payload?.summary || payload?.recentMemory || null;
  const summary = formatRecentMemoryForDisplay(memory);
  const topics = Array.isArray(memory?.topics) ? memory.topics.slice(0, 4) : [];

  setText(elements.recentSummary, summary || 'nothing useful carried yet');
  if (!summary) {
    setText(elements.recentTurns, 'nothing useful carried yet');
    return;
  }
  const item = document.createElement('article');
  item.className = 'draft-item';
  const title = document.createElement('strong');
  title.textContent = 'Carrying';
  const body = document.createElement('p');
  body.textContent = summary;
  item.append(title, body);
  if (topics.length > 0) {
    const topicLine = document.createElement('span');
    topicLine.textContent = `threads: ${topics.join(', ')}`;
    item.append(topicLine);
  }
  elements.recentTurns.replaceChildren(item);
}

function formatRecentMemoryForDisplay(memory) {
  if (!memory || typeof memory !== 'object') return '';
  const topics = Array.isArray(memory.topics) ? memory.topics : [];
  const qualityNotes = Array.isArray(memory.quality_notes) ? memory.quality_notes : [];
  const summary = cleanPreviewText(memory.summary || '');
  if (topics.includes('answer quality') || qualityNotes.length > 0) {
    return 'Answer quality has been the pressure point; use what just happened instead of quoting old replies.';
  }
  if (topics.includes('customer reply drafting')) {
    return 'Customer reply drafting is in motion; keep it local and reviewable until a human sends it.';
  }
  if (topics.includes('local task review')) {
    return 'A local review task is in motion; keep the linked draft and decision together.';
  }
  return summary
    .replace(/Most recent thread:\s*/i, '')
    .replace(/Recurring areas:\s*/i, '')
    .replace(/Tone\/quality:\s*/i, '')
    .replace(/Open loop:\s*/i, '')
    .replace(/Needs:\s*/i, '')
    .replace(/distilled thread summary/gi, 'recent thread')
    .replace(/dumping raw prior replies/gi, 'quoting old replies')
    .replace(/narrating the machinery/gi, 'explaining itself')
    .trim();
}

async function sendTurn(text) {
  const messageId = `${state.sessionId}-turn-${state.turnCounter++}`;
  const useModel = elements.useModel.checked;
  const response = await fetch('/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      sessionId: state.sessionId,
      messageId,
      useModel,
      modelProvider: state.selectedModel?.provider === 'unwired' ? null : state.selectedModel?.provider,
      modelName: state.selectedModel?.model || null,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    const message = payload?.error?.message || 'Mira runtime turn failed.';
    throw new Error(message);
  }
  payload.clientTurn = {
    messageId,
    useModel,
  };
  return payload;
}

function visibleTurnContent(payload) {
  return String(payload?.visibleReply?.content || payload?.response?.content || '').trim();
}

function buildTurnMetadata(payload) {
  return {
    protocol: 'mira.turn_quality_capture_metadata.v0',
    sessionId: payload?.input?.sessionId || state.sessionId,
    messageId: payload?.clientTurn?.messageId || null,
    input: {
      text: payload?.input?.text || '',
    },
    model: payload?.model || null,
    modelInvoked: payload?.modelInvoked === true,
    voiceLab: payload?.voiceLab || null,
    personaCore: payload?.personaCore || null,
    recentMemory: payload?.recentMemory || null,
    state: payload?.state || null,
    operatorContext: payload?.operatorContext ? {
      loaded: payload.operatorContext.loaded === true,
      schema: payload.operatorContext.schema || null,
      relativePath: payload.operatorContext.relativePath || null,
    } : null,
  };
}

async function captureCorrection(payload, prompt, better = '') {
  const response = await fetch('/voice/correction', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      soundedFake: visibleTurnContent(payload),
      better,
      caseId: payload.voiceLab?.caseId || null,
      source: 'runtime-ui',
      turnMetadata: buildTurnMetadata(payload),
    }),
  });
  const result = await response.json();
  if (!response.ok || result?.ok !== true) {
    throw new Error(result?.error?.message || 'Voice correction capture failed.');
  }
  return result;
}

async function refreshCorrections() {
  const response = await fetch('/voice/corrections');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateReviewSummary(payload);
}

async function refreshDrafts() {
  const response = await fetch('/work/drafts');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateDraftList(payload);
}

async function refreshTasks() {
  const response = await fetch('/work/tasks');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateTaskList(payload);
  if (state.selectedTaskToken) {
    try {
      renderReviewPanel(await fetchTaskReview(state.selectedTaskToken));
    } catch {
      state.selectedTaskToken = null;
    }
  }
}

async function refreshReadyPackages() {
  const response = await fetch('/work/ready');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateReadyList(payload);
}

async function refreshSendPackets() {
  const response = await fetch('/work/send-packets');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateSendPacketList(payload);
}

async function refreshSendConfirmations() {
  const response = await fetch('/work/send-confirmations');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateSendConfirmationList(payload);
}

async function refreshSendChecks() {
  const response = await fetch('/work/send-checks');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateSendCheckList(payload);
}

async function refreshRoutePreviewHistory() {
  const response = await fetch('/mission-control/route-previews');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateRoutePreviewHistoryList(payload);
}

async function refreshRouteRequests() {
  const response = await fetch('/mission-control/internal-route-requests');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateRouteRequestList(payload);
}

async function refreshRouteContinuations() {
  const response = await fetch('/mission-control/owned-work-continuations');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateRouteContinuationList(payload);
}

async function refreshRouteFollowThroughRecommendations() {
  const response = await fetch('/mission-control/follow-through-recommendations');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateRouteFollowThroughList(payload);
}

async function refreshRouteDeliveryPreviews() {
  const response = await fetch('/mission-control/internal-delivery-previews');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateRouteDeliveryPreviewList(payload);
}

async function refreshDispatchReadiness() {
  const response = await fetch('/mission-control/dispatch-readiness');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateDispatchReadinessList(payload);
}

async function refreshInternalSendDryRuns() {
  const response = await fetch('/mission-control/internal-send-dry-runs');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateInternalSendDryRunList(payload);
}

async function refreshInternalSendActivationDesigns() {
  const response = await fetch('/mission-control/internal-send-activation-designs');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateInternalSendActivationDesignList(payload);
}

async function refreshInternalSendActivationRequests() {
  const response = await fetch('/mission-control/internal-send-activation-requests');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateInternalSendActivationRequestList(payload);
}

async function refreshAutonomy() {
  const response = await fetch('/autonomy/status');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateAutonomyList(payload);
}

async function runAutonomyTick() {
  const response = await fetch('/autonomy/tick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Autonomy tick failed.');
  }
  return payload;
}

async function runAutonomyFollowThrough() {
  const response = await fetch('/autonomy/follow-through', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Autonomy follow-through failed.');
  }
  return payload;
}

async function refreshRecentTurns() {
  const response = await fetch('/conversation/memory');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateRecentTurns(payload);
}

async function refreshSquidRunContext() {
  const response = await fetch('/squidrun/context');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateSquidRunContext(payload);
}

async function createDraft(text) {
  const response = await fetch('/work/drafts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      kind: 'customer_reply',
      sessionId: state.sessionId,
      messageId: `${state.sessionId}-draft-${state.turnCounter++}`,
      source: 'runtime-ui',
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Draft creation failed.');
  }
  return payload;
}

async function createTaskFromDraft(draft) {
  const response = await fetch('/work/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceDraftToken: draft.actionToken,
      sessionId: state.sessionId,
      messageId: `${state.sessionId}-task-${state.turnCounter++}`,
      source: 'runtime-ui',
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Task creation failed.');
  }
  return payload;
}

async function fetchTaskReview(taskToken) {
  const response = await fetch(`/work/task-review?taskToken=${encodeURIComponent(taskToken || '')}`);
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Task review load failed.');
  }
  return payload;
}

async function submitTaskReview(input) {
  const response = await fetch('/work/task-review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      taskToken: input.taskToken,
      decision: input.decision,
      editedDraftText: input.editedDraftText,
      note: input.note,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Task review save failed.');
  }
  return payload;
}

async function createReadyPackage(input) {
  const response = await fetch('/work/ready', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      taskToken: input.taskToken,
      reviewToken: input.reviewToken,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Ready package creation failed.');
  }
  return payload;
}

async function createSendPacket(input) {
  const response = await fetch('/work/send-packets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      readyToken: input.readyToken,
      recipient: input.recipient,
      channel: input.channel,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Send packet creation failed.');
  }
  return payload;
}

async function createSendConfirmation(input) {
  const response = await fetch('/work/send-confirmations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      packetToken: input.packetToken,
      confirmText: input.confirmText,
      confirmedBy: 'James',
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Manual confirmation failed.');
  }
  return payload;
}

async function createSendCheck(input) {
  const response = await fetch('/work/send-checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      confirmationToken: input.confirmationToken,
      refresh: true,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Pre-send check failed.');
  }
  return payload;
}

async function saveMissionControlRoutePreview() {
  const preview = state.missionControl?.internalRoutePreview;
  if (!preview || preview.status !== 'reviewed_preview_only') {
    throw new Error('Mission Control route preview is not ready to save.');
  }
  const response = await fetch('/mission-control/route-previews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      preview,
      missionAnswer: state.missionControl?.answer || '',
      source: 'runtime-ui',
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Mission Control route preview save failed.');
  }
  return payload;
}

async function createRouteRequestFromPreview(preview) {
  const response = await fetch('/mission-control/internal-route-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      previewToken: preview?.actionToken || '',
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Mission Control route review item save failed.');
  }
  return payload;
}

async function createOwnedWorkContinuation(input) {
  const response = await fetch('/mission-control/owned-work-continuations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestToken: input.requestToken,
      decision: input.decision,
      editedContent: input.editedContent,
      note: input.note,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Mission Control continuation save failed.');
  }
  return payload;
}

async function createInternalDeliveryPreview(recommendation) {
  const response = await fetch('/mission-control/internal-delivery-previews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recommendationToken: recommendation?.actionToken || '',
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Mission Control delivery preview save failed.');
  }
  return payload;
}

async function createDispatchReadiness(preview) {
  const response = await fetch('/mission-control/dispatch-readiness', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deliveryPreviewToken: preview?.actionToken || '',
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Mission Control dispatch-readiness save failed.');
  }
  return payload;
}

async function createInternalSendDryRun(readiness) {
  const response = await fetch('/mission-control/internal-send-dry-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dispatchReadinessToken: readiness?.actionToken || '',
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Mission Control internal-send dry-run save failed.');
  }
  return payload;
}

async function createInternalSendActivationDesign(dryRun) {
  const response = await fetch('/mission-control/internal-send-activation-designs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      internalSendDryRunToken: dryRun?.actionToken || '',
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Mission Control activation-design proof save failed.');
  }
  return payload;
}

async function createInternalSendActivationRequest(design) {
  const response = await fetch('/mission-control/internal-send-activation-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      internalSendActivationDesignToken: design?.actionToken || '',
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || 'Mission Control activation request preview save failed.');
  }
  return payload;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

async function refreshModelStatus() {
  try {
    const choicesResponse = await fetch('/model/providers');
    const choicesPayload = await choicesResponse.json();
    if (choicesResponse.ok && choicesPayload?.ok === true) {
      updateModelChoices(choicesPayload);
    }
    const response = await fetch('/model/status');
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) return;
    updateModelSummary(payload);
  } catch {
    updateModelSummary(null);
  }
}

async function refreshRuntimeReadiness() {
  const [sessionResponse, capabilitiesResponse] = await Promise.all([
    fetch('/session'),
    fetch('/capabilities'),
  ]);
  const sessionPayload = await sessionResponse.json();
  const capabilitiesPayload = await capabilitiesResponse.json();
  if (!sessionResponse.ok || !capabilitiesResponse.ok) return;
  updateReadOnlyRuntimeState(sessionPayload, capabilitiesPayload);
}

function attachCorrectionControl(article, payload, prompt) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'subtle-button';
  button.textContent = 'wrong shape';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await captureCorrection(payload, prompt);
      button.textContent = 'captured';
      await refreshCorrections();
      await refreshRecentTurns();
    } catch (error) {
      button.disabled = false;
      appendMessage('mira', error.message, 'error');
    }
  });
  actions.append(button);
  article.append(actions);
}

async function primeReadOnlyWorkbench() {
  try {
    await refreshModelStatus();
    await refreshRuntimeReadiness();
    await refreshSquidRunContext();
    await refreshCorrections();
    await refreshDrafts();
    await refreshTasks();
    await refreshReadyPackages();
    await refreshSendPackets();
    await refreshSendConfirmations();
    await refreshSendChecks();
    await refreshRoutePreviewHistory();
    await refreshRouteRequests();
    await refreshRouteContinuations();
    await refreshRouteFollowThroughRecommendations();
    await refreshRouteDeliveryPreviews();
    await refreshDispatchReadiness();
    await refreshInternalSendDryRuns();
    await refreshInternalSendActivationDesigns();
    await refreshInternalSendActivationRequests();
    await refreshAutonomy();
  } catch (error) {
    renderChips([{ label: 'runtime needs key/state', kind: 'warn' }]);
    setText(elements.lastTurn, error.message);
  }
}

elements.contextToggle.addEventListener('click', async () => {
  const shouldOpen = elements.contextPanel.hidden;
  elements.contextPanel.hidden = !shouldOpen;
  elements.contextToggle.setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen) {
    await refreshModelStatus();
    await refreshSquidRunContext();
    await refreshCorrections();
    await refreshDrafts();
    await refreshTasks();
    await refreshReadyPackages();
    await refreshSendPackets();
    await refreshSendConfirmations();
    await refreshSendChecks();
    await refreshRoutePreviewHistory();
    await refreshRouteRequests();
    await refreshRouteContinuations();
    await refreshRouteFollowThroughRecommendations();
    await refreshRouteDeliveryPreviews();
    await refreshDispatchReadiness();
    await refreshInternalSendDryRuns();
    await refreshInternalSendActivationDesigns();
    await refreshInternalSendActivationRequests();
    await refreshAutonomy();
    await refreshRecentTurns();
  }
});

elements.modelProviderSelect.addEventListener('change', () => {
  const option = elements.modelProviderSelect.selectedOptions[0];
  state.selectedModel = {
    id: elements.modelProviderSelect.value,
    provider: option?.dataset.provider || null,
    model: option?.dataset.model || null,
  };
});

elements.text.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (typeof elements.form.requestSubmit === 'function') {
    elements.form.requestSubmit();
    return;
  }
  elements.sendButton.click();
});

elements.draftButton.addEventListener('click', async () => {
  const text = elements.text.value.trim();
  if (!text) return;

  elements.draftButton.disabled = true;
  elements.draftButton.textContent = 'Drafting';
  try {
    await createDraft(text);
    appendMessage('mira', 'Draft saved for review.');
    await refreshDrafts();
  } catch (error) {
    appendMessage('mira', error.message, 'error');
  } finally {
    elements.draftButton.disabled = false;
    elements.draftButton.textContent = 'Draft';
    elements.text.focus();
  }
});

elements.autonomyTickButton.addEventListener('click', async () => {
  elements.autonomyTickButton.disabled = true;
  elements.autonomyTickButton.textContent = 'Running';
  try {
    const payload = await runAutonomyTick();
    updateAutonomyList(payload);
    appendMessage('mira', `Added ${payload.createdCount || 0} local next moves. Nothing external was sent.`);
  } catch (error) {
    appendMessage('mira', error.message, 'error');
  } finally {
    elements.autonomyTickButton.disabled = false;
    elements.autonomyTickButton.textContent = 'Run local tick';
  }
});

elements.autonomyFollowButton.addEventListener('click', async () => {
  elements.autonomyFollowButton.disabled = true;
  elements.autonomyFollowButton.textContent = 'Working';
  try {
    const payload = await runAutonomyFollowThrough();
    updateAutonomyList(payload);
    appendMessage('mira', `Prepared ${payload.createdCount || 0} local follow-through steps.`);
  } catch (error) {
    appendMessage('mira', error.message, 'error');
  } finally {
    elements.autonomyFollowButton.disabled = false;
    elements.autonomyFollowButton.textContent = 'Follow through';
  }
});

elements.saveRoutePreviewButton.addEventListener('click', async () => {
  elements.saveRoutePreviewButton.disabled = true;
  elements.saveRoutePreviewButton.textContent = 'Saving';
  try {
    const payload = await saveMissionControlRoutePreview();
    updateRoutePreviewHistoryList({
      ok: true,
      previewCount: Math.max(state.missionControlRoutePreviewCount, 0) + (payload.created ? 1 : 0),
      previews: [payload.record],
    });
    appendMessage('mira', 'Route preview saved for internal review. Nothing was sent or executed.');
    await refreshRoutePreviewHistory();
    await refreshRouteRequests();
    await refreshRouteContinuations();
    await refreshRouteFollowThroughRecommendations();
    await refreshRouteDeliveryPreviews();
    await refreshDispatchReadiness();
    await refreshInternalSendDryRuns();
    await refreshInternalSendActivationDesigns();
    await refreshInternalSendActivationRequests();
  } catch (error) {
    appendMessage('mira', error.message, 'error');
  } finally {
    elements.saveRoutePreviewButton.disabled = false;
    elements.saveRoutePreviewButton.textContent = 'Save preview for review';
  }
});

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = elements.text.value.trim();
  if (!text) return;

  appendMessage('user', text);
  elements.text.value = '';
  elements.sendButton.disabled = true;
  elements.sendButton.textContent = 'Sending';
  try {
    if (isMissionControlQuestion(text) && answerMissionControlQuestion()) {
      return;
    }
    const payload = await sendTurn(text);
    updateRuntimeState(payload);
    const article = appendMessage('mira', visibleTurnContent(payload));
    attachCorrectionControl(article, payload, text);
    await refreshRecentTurns();
  } catch (error) {
    appendMessage('mira', error.message, 'error');
    await refreshRecentTurns();
  } finally {
    elements.sendButton.disabled = false;
    elements.sendButton.textContent = 'Send';
    elements.text.focus();
  }
});

window.addEventListener('resize', syncWorkbenchForViewport);
syncWorkbenchForViewport();
primeReadOnlyWorkbench();
