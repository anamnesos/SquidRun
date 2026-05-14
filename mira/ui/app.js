'use strict';

const state = {
  sessionId: `mira-ui-${Date.now()}`,
  turnCounter: 0,
};

const elements = {
  form: document.getElementById('turnForm'),
  text: document.getElementById('turnText'),
  useModel: document.getElementById('useModel'),
  sendButton: document.getElementById('sendButton'),
  thread: document.getElementById('thread'),
  statusStrip: document.getElementById('statusStrip'),
  contextToggle: document.getElementById('contextToggle'),
  contextPanel: document.getElementById('contextPanel'),
  brainLine: document.getElementById('brainLine'),
  operatorSummary: document.getElementById('operatorSummary'),
  coreSummary: document.getElementById('coreSummary'),
  lastTurn: document.getElementById('lastTurn'),
  modelSummary: document.getElementById('modelSummary'),
  reviewSummary: document.getElementById('reviewSummary'),
};

let modelStatus = null;

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
  if (!context || context.loaded !== true) return 'not loaded';
  const lanes = Array.isArray(context.operatingLanes) ? context.operatingLanes.join(', ') : '';
  return `${context.businessThesis || 'operator context loaded'} ${lanes ? `(${lanes})` : ''}`;
}

function summarizeCore(payload) {
  const core = payload?.loadedCoreSummary;
  if (!core || core.available !== true) return 'not loaded';
  return [
    core.identity,
    core.relationship,
    core.permissions,
  ].filter(Boolean).join(' | ');
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
  setText(elements.lastTurn, payload?.modelInvoked ? 'model-backed' : 'deterministic');
}

function updateModelSummary(payload) {
  modelStatus = payload || null;
  if (!payload) {
    setText(elements.brainLine, 'model unknown');
    setText(elements.modelSummary, 'unknown');
    return;
  }
  const state = payload.available ? 'ready' : 'not ready';
  const provider = payload.selectedProvider === 'ollama_chat' ? 'Gemma/Ollama' : 'OpenAI';
  setText(elements.brainLine, `${provider}: ${payload.model} ${state}`);
  setText(elements.modelSummary, `${payload.model} (${payload.selectedProvider}) is ${state}. ${payload.nextLocalModelStep || ''}`.trim());
}

function updateReviewSummary(payload) {
  const count = Number(payload?.pending_count || 0);
  setText(elements.reviewSummary, count === 1 ? '1 pending correction' : `${count} pending corrections`);
}

async function sendTurn(text) {
  const response = await fetch('/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      sessionId: state.sessionId,
      messageId: `${state.sessionId}-turn-${state.turnCounter++}`,
      useModel: elements.useModel.checked,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    const message = payload?.error?.message || 'Mira runtime turn failed.';
    throw new Error(message);
  }
  return payload;
}

async function captureCorrection(payload, prompt, better) {
  const response = await fetch('/voice/correction', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      soundedFake: payload.response.content,
      better,
      caseId: payload.voiceLab?.caseId || null,
      source: 'runtime-ui',
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

async function refreshModelStatus() {
  try {
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
    const better = window.prompt('Better phrasing?');
    if (!better || !better.trim()) return;
    button.disabled = true;
    try {
      await captureCorrection(payload, prompt, better);
      button.textContent = 'captured';
      await refreshCorrections();
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
  } catch (error) {
    appendMessage('mira', error.message, 'error');
  } finally {
    elements.sendButton.disabled = false;
    elements.sendButton.textContent = 'Send';
    elements.text.focus();
  }
});

prime();
