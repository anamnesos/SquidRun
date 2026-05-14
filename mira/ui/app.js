'use strict';

const state = {
  sessionId: `mira-ui-${Date.now()}`,
  turnCounter: 0,
  selectedModel: null,
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

function updateDraftList(payload) {
  const drafts = Array.isArray(payload?.drafts) ? payload.drafts : [];
  setText(elements.workSummary, `${drafts.length} drafts`);
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
        const task = await createTaskFromDraft(draft);
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
  const current = elements.workSummary.textContent || '';
  setText(elements.workSummary, `${current}${current ? ' / ' : ''}${tasks.length} tasks`);
  if (tasks.length === 0) {
    setText(elements.taskList, 'none yet');
    return;
  }
  elements.taskList.replaceChildren(...tasks.slice(0, 5).map((task) => {
    const item = document.createElement('article');
    item.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = cleanPreviewText(task.displayTitle) || 'Review task';
    const source = document.createElement('span');
    source.textContent = task.sourceDraftLinked ? 'source draft linked' : 'source draft missing';
    item.append(title, source);
    appendPreviewLine(item, 'Task', task.taskPreview || task.preview);
    appendPreviewLine(item, 'Checklist', task.checklistPreview);
    return item;
  }));
}

function updateRecentTurns(payload) {
  const records = Array.isArray(payload?.records) ? payload.records : [];
  setText(elements.recentSummary, records.length === 0 ? 'no turns yet' : `${records.length} recent turns`);
  if (records.length === 0) {
    setText(elements.recentTurns, 'none yet');
    return;
  }
  elements.recentTurns.replaceChildren(...records.slice(0, 6).map((record) => {
    const item = document.createElement('article');
    item.className = 'draft-item';
    const title = document.createElement('strong');
    title.textContent = record.outcome === 'error' ? 'error turn' : 'turn';
    const meta = document.createElement('span');
    const model = record.model?.model || (record.model_invoked ? 'model' : 'deterministic');
    meta.textContent = `${model} · ${record.outcome || 'ok'}`;
    const prompt = document.createElement('p');
    prompt.textContent = record.prompt || '';
    const reply = document.createElement('p');
    reply.textContent = record.response?.content || record.error?.message || '';
    item.append(title, meta, prompt, reply);
    return item;
  }));
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
    recentTurns: Array.isArray(payload?.recentTurns) ? payload.recentTurns.slice(0, 3) : [],
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
      soundedFake: payload.response.content,
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
}

async function refreshRecentTurns() {
  const response = await fetch('/conversation/recent?limit=6');
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) return;
  updateRecentTurns(payload);
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

async function prime() {
  try {
    const useModel = elements.useModel.checked;
    elements.useModel.checked = false;
    await refreshModelStatus();
    const payload = await sendTurn('status');
    elements.useModel.checked = useModel;
    updateRuntimeState(payload);
    await refreshCorrections();
    await refreshDrafts();
    await refreshTasks();
    await refreshRecentTurns();
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
    await refreshCorrections();
    await refreshDrafts();
    await refreshTasks();
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
    const payload = await createDraft(text);
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

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = elements.text.value.trim();
  if (!text) return;

  appendMessage('user', text);
  elements.text.value = '';
  elements.sendButton.disabled = true;
  elements.sendButton.textContent = 'Sending';
  try {
    const payload = await sendTurn(text);
    updateRuntimeState(payload);
    const article = appendMessage('mira', payload.response.content);
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
prime();
