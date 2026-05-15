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
  setText(elements.workSummary, `${state.workDraftCount} drafts / ${state.workPendingCount} pending / ${state.workReviewedCount} reviewed / ${state.workReadyCount} ready / ${state.workSendPacketCount} not sent / ${state.workSendConfirmationCount} confirmed / ${state.workSendCheckCount} checked / ${state.autonomyQueueCount} next moves / ${state.autonomyFollowThroughCount} followed`);
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
    await refreshReadyPackages();
    await refreshSendPackets();
    await refreshSendConfirmations();
    await refreshSendChecks();
    await refreshAutonomy();
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
    await refreshReadyPackages();
    await refreshSendPackets();
    await refreshSendConfirmations();
    await refreshSendChecks();
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
