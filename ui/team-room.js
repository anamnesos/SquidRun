(() => {
  'use strict';

  document.documentElement.dataset.roomShell = /\bElectron\//u.test(navigator.userAgent || '') ? 'desktop' : 'web';

  const elements = {
    app: document.getElementById('roomApp'),
    column: document.getElementById('messageColumn'),
    scroll: document.getElementById('messageScroll'),
    composer: document.getElementById('composerShell'),
    composerForm: document.getElementById('composerForm'),
    input: document.getElementById('messageInput'),
    send: document.getElementById('sendButton'),
    dot: document.getElementById('connectionDot'),
    banner: document.getElementById('disconnectBanner'),
    attachmentButton: document.getElementById('attachmentButton'),
    fileInput: document.getElementById('fileInput'),
    uploadCount: document.getElementById('uploadCount'),
    uploadTray: document.getElementById('uploadTray'),
    uploadAnnouncements: document.getElementById('uploadAnnouncements'),
    attachmentHint: document.getElementById('attachmentHint'),
    dropShield: document.getElementById('dropShield'),
    pairScreen: document.getElementById('pairScreen'),
    pairForm: document.getElementById('pairForm'),
    pairCode: document.getElementById('pairCode'),
    pairError: document.getElementById('pairError'),
    pairButton: document.getElementById('pairPhoneButton'),
    remotePairButton: document.getElementById('remotePairButton'),
    remoteAccessButton: document.getElementById('remoteAccessButton'),
    remoteAccessLabel: document.getElementById('remoteAccessLabel'),
    roomOverflow: document.getElementById('roomOverflow'),
    roomOverflowTrigger: document.getElementById('roomOverflowTrigger'),
    roomOverflowState: document.getElementById('roomOverflowState'),
    notificationButton: document.getElementById('notificationButton'),
    notificationDialog: document.getElementById('notificationDialog'),
    notificationDialogClose: document.getElementById('notificationDialogClose'),
    notificationStatus: document.getElementById('notificationStatus'),
    notificationToggle: document.getElementById('notificationToggle'),
    notificationQuietHours: document.getElementById('notificationQuietHours'),
    notificationQuietStart: document.getElementById('notificationQuietStart'),
    notificationQuietEnd: document.getElementById('notificationQuietEnd'),
    notificationError: document.getElementById('notificationError'),
    pairDialog: document.getElementById('pairDialog'),
    pairInstruction: document.getElementById('pairInstruction'),
    pairQrShell: document.getElementById('pairQrShell'),
    pairQrImage: document.getElementById('pairQrImage'),
    pairUrl: document.getElementById('pairUrl'),
    pairCodeDisplay: document.getElementById('pairCodeDisplay'),
    pairExpiry: document.getElementById('pairExpiry'),
    pairDialogError: document.getElementById('pairDialogError'),
    lightbox: document.getElementById('mediaLightbox'),
    lightboxName: document.getElementById('lightboxName'),
    lightboxMeta: document.getElementById('lightboxMeta'),
    lightboxDownload: document.getElementById('lightboxDownload'),
    lightboxClose: document.getElementById('lightboxClose'),
    lightboxStage: document.getElementById('lightboxStage'),
    lightboxImage: document.getElementById('lightboxImage'),
    unreadMarker: document.getElementById('unreadMarker'),
    unreadMarkerLabel: document.getElementById('unreadMarkerLabel'),
  };

  const state = {
    config: null,
    connected: false,
    connectedOnce: false,
    authenticated: false,
    messages: [],
    attachments: [],
    socket: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    pairingExpiryTimer: null,
    pendingPairingCode: null,
    remoteAccess: { manageable: false, enabled: false, pending: false, reason: null, detail: null },
    notifications: {
      manageable: false,
      enabled: false,
      pending: false,
      quietStart: '23:30',
      quietEnd: '07:30',
      guidance: '',
    },
    serviceWorkerRegistration: null,
    presenceTimer: null,
    sending: false,
    outbox: [],
    restoredOutbox: false,
    drainingOutbox: false,
    outboxRetryTimer: null,
    outboxRetryAttempt: 0,
    dragDepth: 0,
    unreadCount: 0,
    restoredDrafts: false,
    viewportBaselineHeight: 0,
    pendingTypewriterMessageIds: new Set(),
    activeTypewriters: new Map(),
    lightbox: { scale: 1, x: 0, y: 0, pointers: new Map(), gesture: null, settleTimer: null },
  };

  const draftKey = 'squidrun.team-room.draft.v1';
  const draftDatabaseName = 'squidrun-team-room-drafts-v1';
  const draftStoreName = 'attachments';
  const outboxStoreName = 'outbox';
  const pairedDeviceKey = 'squidrun.team-room.paired-device.v1';
  const defaultMaxAttachmentBytes = 50 * 1024 * 1024;
  const maxAttachmentsPerMessage = 12;
  const typewriterMinDurationMs = 280;
  const typewriterMaxDurationMs = 1_800;
  const typewriterMsPerCharacter = 20;
  const reducedMotionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  let draftDatabasePromise = null;

  function setConnection(status) {
    state.connected = status === 'connected';
    if (state.connected) state.connectedOnce = true;
    elements.dot.dataset.state = status;
    elements.dot.setAttribute('aria-label', status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Disconnected');
    elements.banner.hidden = status !== 'disconnected' || !state.authenticated;
    updateSendState();
    if (state.connected) {
      resumeDraftUploads();
      void drainOutbox();
    }
  }

  async function fetchJson(route, options = {}) {
    const response = await fetch(route, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    return { response, payload };
  }

  function openDraftDatabase() {
    if (!globalThis.indexedDB) return Promise.resolve(null);
    if (draftDatabasePromise) return draftDatabasePromise;
    draftDatabasePromise = new Promise((resolve) => {
      const request = indexedDB.open(draftDatabaseName, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(draftStoreName)) {
          request.result.createObjectStore(draftStoreName, { keyPath: 'localId' });
        }
        if (!request.result.objectStoreNames.contains(outboxStoreName)) {
          request.result.createObjectStore(outboxStoreName, { keyPath: 'clientNonce' });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => { draftDatabasePromise = null; resolve(null); };
      request.onblocked = () => { draftDatabasePromise = null; resolve(null); };
    });
    return draftDatabasePromise;
  }

  async function withDatabaseStore(storeName, mode, operation) {
    const database = await openDraftDatabase();
    if (!database) return null;
    return new Promise((resolve) => {
      let transaction;
      let request;
      let result = true;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        transaction = database.transaction(storeName, mode);
        request = operation(transaction.objectStore(storeName));
      } catch {
        finish(null);
        return;
      }
      if (request) {
        request.onsuccess = () => { result = request.result === undefined ? true : request.result; };
        request.onerror = () => finish(null);
      }
      transaction.oncomplete = () => finish(result);
      transaction.onerror = () => finish(null);
      transaction.onabort = () => finish(null);
    });
  }

  function withDraftStore(mode, operation) {
    return withDatabaseStore(draftStoreName, mode, operation);
  }

  function withOutboxStore(mode, operation) {
    return withDatabaseStore(outboxStoreName, mode, operation);
  }

  function serializableAttachment(item) {
    return {
      localId: item.localId,
      name: item.name,
      type: item.type,
      size: item.size,
      lastModified: item.lastModified,
      file: item.file || null,
      status: item.status,
      progress: Number(item.progress) || 0,
      attachment: item.attachment || null,
      error: item.error || null,
      createdAtMs: item.createdAtMs,
    };
  }

  function persistAttachment(item) {
    if (item.removed) return Promise.resolve();
    return withDraftStore('readwrite', (store) => store.put(serializableAttachment(item)));
  }

  function deletePersistedAttachment(localId) {
    return withDraftStore('readwrite', (store) => store.delete(localId));
  }

  function clearPersistedAttachments() {
    return withDraftStore('readwrite', (store) => store.clear());
  }

  function serializableOutboxAttachment(item) {
    return {
      localId: item.localId,
      name: item.name,
      type: item.type,
      size: item.size,
      lastModified: item.lastModified,
      file: item.file || null,
      attachment: item.attachment || null,
    };
  }

  function serializableOutboxRecord(record) {
    return {
      clientNonce: record.clientNonce,
      body: record.body,
      createdAtMs: record.createdAtMs,
      attachments: record.attachments.map(serializableOutboxAttachment),
    };
  }

  function persistOutboxRecord(record) {
    return withOutboxStore('readwrite', (store) => store.put(serializableOutboxRecord(record)));
  }

  function deleteOutboxRecord(clientNonce) {
    return withOutboxStore('readwrite', (store) => store.delete(clientNonce));
  }

  function formatClock(timestamp) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function dayKey(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function formatDay(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (dayKey(date) === dayKey(today)) return 'Today';
    if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
    return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' }).format(date);
  }

  function appendInline(parent, input) {
    const source = String(input || '');
    const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|https?:\/\/[^\s<]+)/gu;
    let cursor = 0;
    for (const match of source.matchAll(tokenPattern)) {
      if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
      const token = match[0];
      if (token.startsWith('`')) {
        const code = document.createElement('code');
        code.textContent = token.slice(1, -1);
        parent.append(code);
      } else if (token.startsWith('**')) {
        const strong = document.createElement('strong');
        strong.textContent = token.slice(2, -2);
        parent.append(strong);
      } else {
        const anchor = document.createElement('a');
        anchor.href = token;
        anchor.rel = 'noreferrer noopener';
        anchor.textContent = token;
        parent.append(anchor);
      }
      cursor = match.index + token.length;
    }
    if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
  }

  function renderMarkdown(body) {
    const root = document.createDocumentFragment();
    const lines = String(body || '').replace(/\r\n/gu, '\n').split('\n');
    let paragraph = null;
    let list = null;
    let listType = null;
    let code = null;
    const flushParagraph = () => { paragraph = null; };
    const flushList = () => { list = null; listType = null; };
    for (const line of lines) {
      if (line.startsWith('```')) {
        flushParagraph();
        flushList();
        if (code) { code = null; continue; }
        const pre = document.createElement('pre');
        code = document.createElement('code');
        pre.append(code);
        root.append(pre);
        continue;
      }
      if (code) { code.textContent += `${code.textContent ? '\n' : ''}${line}`; continue; }
      if (!line.trim()) { flushParagraph(); flushList(); continue; }
      const listMatch = /^\s*(-|\*|\d+\.)\s+(.+)$/u.exec(line);
      if (listMatch) {
        flushParagraph();
        const nextType = /\d/u.test(listMatch[1]) ? 'ol' : 'ul';
        if (!list || listType !== nextType) {
          list = document.createElement(nextType);
          listType = nextType;
          root.append(list);
        }
        const item = document.createElement('li');
        appendInline(item, listMatch[2]);
        list.append(item);
        continue;
      }
      flushList();
      const quoteMatch = /^\s*>\s?(.*)$/u.exec(line);
      if (quoteMatch) {
        flushParagraph();
        const quote = document.createElement('blockquote');
        appendInline(quote, quoteMatch[1]);
        root.append(quote);
        continue;
      }
      const headingMatch = /^\s*#{1,6}\s+(.+)$/u.exec(line);
      if (headingMatch) {
        flushParagraph();
        const heading = document.createElement('p');
        heading.className = 'message-heading';
        appendInline(heading, headingMatch[1]);
        root.append(heading);
        continue;
      }
      if (!paragraph) {
        paragraph = document.createElement('p');
        root.append(paragraph);
      } else paragraph.append(document.createElement('br'));
      appendInline(paragraph, line);
    }
    return root;
  }

  function prefersReducedMotion() {
    return reducedMotionQuery?.matches === true;
  }

  function finishActiveTypewriters() {
    for (const controller of [...state.activeTypewriters.values()]) controller.finish();
  }

  function shouldTypewriterMessage(message) {
    return Boolean(
      message?.messageId
      && message?.body
      && message.author?.memberKind === 'agent'
      && !prefersReducedMotion()
    );
  }

  function startTypewriter(message, item, body, { followBottom = false } = {}) {
    const textNodes = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const characters = Array.from(walker.currentNode.textContent || '');
      if (characters.length > 0) textNodes.push({ node: walker.currentNode, characters });
    }
    const totalCharacters = textNodes.reduce((sum, entry) => sum + entry.characters.length, 0);
    if (totalCharacters < 2 || prefersReducedMotion()) return;

    let finished = false;
    let frameId = null;
    let finishTimerId = null;
    let keepFollowingBottom = followBottom;
    const durationMs = Math.min(
      typewriterMaxDurationMs,
      Math.max(typewriterMinDurationMs, totalCharacters * typewriterMsPerCharacter)
    );
    const startedAt = performance.now();

    const reveal = (visibleCharacters) => {
      let remaining = visibleCharacters;
      for (const entry of textNodes) {
        const visibleInNode = Math.max(0, Math.min(entry.characters.length, remaining));
        entry.node.textContent = entry.characters.slice(0, visibleInNode).join('');
        remaining -= visibleInNode;
      }
      if (keepFollowingBottom) {
        if (closeEnoughToBottom()) elements.scroll.scrollTop = elements.scroll.scrollHeight;
        else keepFollowingBottom = false;
      }
    };

    const skip = (event) => {
      event.preventDefault();
      event.stopPropagation();
      finish();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (finishTimerId !== null) clearTimeout(finishTimerId);
      for (const entry of textNodes) entry.node.textContent = entry.characters.join('');
      delete item.dataset.typewriterActive;
      delete body.dataset.typewriterActive;
      body.removeEventListener('click', skip);
      state.activeTypewriters.delete(message.messageId);
      if (keepFollowingBottom) elements.scroll.scrollTop = elements.scroll.scrollHeight;
    };

    const tick = (now) => {
      if (finished) return;
      const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
      reveal(Math.max(1, Math.ceil(totalCharacters * progress)));
      if (progress >= 1) finish();
      else frameId = requestAnimationFrame(tick);
    };

    item.dataset.typewriterActive = 'true';
    body.dataset.typewriterActive = 'true';
    body.addEventListener('click', skip);
    state.activeTypewriters.set(message.messageId, { finish });
    reveal(1);
    finishTimerId = setTimeout(finish, durationMs);
    frameId = requestAnimationFrame(tick);
  }

  function closeEnoughToBottom() {
    return elements.scroll.scrollHeight - elements.scroll.scrollTop - elements.scroll.clientHeight < 140;
  }

  function updateUnreadMarker() {
    const count = Math.max(0, Number(state.unreadCount) || 0);
    elements.unreadMarker.hidden = count === 0;
    elements.unreadMarkerLabel.textContent = count === 1 ? '1 new message' : `${count} new messages`;
  }

  function clearUnread() {
    if (state.unreadCount === 0) return;
    state.unreadCount = 0;
    updateUnreadMarker();
  }

  function markUnread(count = 1) {
    state.unreadCount += Math.max(0, Number(count) || 0);
    updateUnreadMarker();
  }

  function captureScrollAnchor() {
    const scrollRect = elements.scroll.getBoundingClientRect();
    const candidates = [...elements.column.querySelectorAll('.message-item[data-message-id]')];
    const anchor = candidates.find((candidate) => candidate.getBoundingClientRect().bottom >= scrollRect.top + 1);
    if (!anchor) return { messageId: null, offset: 0, scrollTop: elements.scroll.scrollTop };
    return {
      messageId: anchor.dataset.messageId,
      offset: anchor.getBoundingClientRect().top - scrollRect.top,
      scrollTop: elements.scroll.scrollTop,
    };
  }

  function restoreScrollAnchor(anchor) {
    if (!anchor) return;
    if (!anchor.messageId) { elements.scroll.scrollTop = anchor.scrollTop; return; }
    const escapedId = globalThis.CSS?.escape ? CSS.escape(anchor.messageId) : anchor.messageId.replace(/["\\]/gu, '\\$&');
    const next = elements.column.querySelector(`.message-item[data-message-id="${escapedId}"]`);
    if (!next) { elements.scroll.scrollTop = anchor.scrollTop; return; }
    const scrollRect = elements.scroll.getBoundingClientRect();
    elements.scroll.scrollTop += next.getBoundingClientRect().top - scrollRect.top - anchor.offset;
  }

  function imageAttachment(attachment) {
    return String(attachment?.mimeType || '').startsWith('image/');
  }

  function openLightbox(attachment) {
    if (!imageAttachment(attachment)) return;
    elements.lightboxName.textContent = attachment.originalName || 'Attachment';
    elements.lightboxMeta.textContent = [formatBytes(attachment.bytes), attachment.width && attachment.height ? `${attachment.width} × ${attachment.height}` : '']
      .filter(Boolean).join(' · ');
    elements.lightboxDownload.href = attachment.downloadUrl || attachment.originalUrl;
    elements.lightboxDownload.download = attachment.originalName || 'attachment';
    elements.lightboxImage.src = attachment.originalUrl || attachment.previewUrl;
    elements.lightboxImage.alt = attachment.originalName || 'Attached image';
    resetLightboxTransform();
    elements.lightbox.showModal();
  }

  function renderMessageAttachments(item, attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return;
    const grid = document.createElement('div');
    grid.className = `message-attachments attachment-count-${Math.min(attachments.length, 3)}`;
    for (const attachment of attachments) {
      if (imageAttachment(attachment)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'media-tile';
        button.setAttribute('aria-label', `Open ${attachment.originalName || 'image'}`);
        const image = document.createElement('img');
        image.src = attachment.previewUrl || attachment.originalUrl;
        image.alt = '';
        image.loading = 'lazy';
        const fallback = document.createElement('span');
        fallback.className = 'media-fallback';
        fallback.textContent = attachment.previewStatus === 'blocked' ? 'Preview blocked · original kept' : 'Open original';
        image.addEventListener('error', () => { image.hidden = true; fallback.hidden = false; });
        fallback.hidden = true;
        const caption = document.createElement('span');
        caption.className = 'media-caption';
        caption.textContent = attachment.originalName || 'Image';
        button.append(image, fallback, caption);
        button.addEventListener('click', () => openLightbox(attachment));
        grid.append(button);
      } else {
        const card = document.createElement(attachment.localOnly ? 'div' : 'a');
        card.className = 'file-tile';
        if (!attachment.localOnly) {
          card.href = attachment.originalUrl;
          card.target = '_blank';
          card.rel = 'noreferrer';
        }
        const mark = document.createElement('span');
        mark.className = 'file-mark';
        mark.textContent = attachment.mimeType === 'application/pdf' ? 'PDF' : 'FILE';
        const label = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = attachment.originalName || 'Attachment';
        const meta = document.createElement('small');
        meta.textContent = formatBytes(attachment.bytes);
        label.append(name, meta);
        card.append(mark, label);
        grid.append(card);
      }
    }
    item.append(grid);
  }

  function createEmptyRoom() {
    const empty = document.createElement('div');
    empty.className = 'empty-room';
    const mark = document.createElement('span');
    mark.className = 'empty-room-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.append(document.createElement('i'), document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const title = document.createElement('strong');
    title.textContent = 'The room is quiet.';
    const copy = document.createElement('span');
    copy.textContent = 'Say what matters. The whole team is here.';
    empty.append(mark, title, copy);
    return empty;
  }

  function renderMessages({ forceBottom = false } = {}) {
    finishActiveTypewriters();
    const stayAtBottom = forceBottom || closeEnoughToBottom();
    const anchor = stayAtBottom ? null : captureScrollAnchor();
    const typewriterCandidates = [];
    elements.column.replaceChildren();
    if (state.messages.length === 0) {
      elements.column.append(createEmptyRoom());
      clearUnread();
      return;
    }
    let currentDay = null;
    let currentRun = null;
    let currentAuthor = null;
    for (const message of state.messages) {
      const messageDay = dayKey(message.createdAtMs);
      if (messageDay !== currentDay) {
        const separator = document.createElement('div');
        separator.className = 'day-separator';
        separator.textContent = formatDay(message.createdAtMs);
        elements.column.append(separator);
        currentDay = messageDay;
        currentRun = null;
        currentAuthor = null;
      }
      if (message.authorId !== currentAuthor) {
        currentRun = document.createElement('article');
        currentRun.className = 'message-run';
        currentRun.dataset.author = message.authorId;
        const heading = document.createElement('header');
        heading.className = 'run-heading';
        const name = document.createElement('span');
        name.className = 'run-name';
        name.textContent = message.author?.displayName || message.authorId;
        const role = document.createElement('span');
        role.className = 'run-role';
        role.textContent = message.author?.memberKind === 'agent'
          ? String(message.author?.role || '').trim()
          : '';
        role.hidden = !role.textContent;
        const time = document.createElement('time');
        time.className = 'run-time';
        time.dateTime = new Date(message.createdAtMs).toISOString();
        time.textContent = formatClock(message.createdAtMs);
        heading.append(name, role, time);
        currentRun.append(heading);
        elements.column.append(currentRun);
        currentAuthor = message.authorId;
      }
      const item = document.createElement('div');
      item.className = 'message-item';
      item.dataset.messageId = message.messageId;
      if (message.pending) item.dataset.pending = 'true';
      if (message.queued) item.dataset.queued = 'true';
      if (message.error) item.dataset.error = 'true';
      if (message.body) {
        const body = document.createElement('div');
        body.className = 'message-body';
        body.append(renderMarkdown(message.body));
        item.append(body);
        if (state.pendingTypewriterMessageIds.delete(message.messageId)) {
          typewriterCandidates.push({ message, item, body });
        }
      }
      renderMessageAttachments(item, message.attachments);
      if (message.pending || message.queued || message.optimistic || message.error) {
        const meta = document.createElement('span');
        meta.className = 'message-meta';
        const mark = document.createElement('span');
        mark.className = message.queued ? 'queued-mark' : message.pending ? 'pending-mark' : 'resolved-mark';
        meta.append(mark, document.createTextNode(message.error
          ? 'Not sent · draft restored'
          : message.queued
            ? 'Queued · will send when back'
            : message.pending
              ? 'Sending'
              : 'Sent'));
        item.append(meta);
      }
      currentRun.append(item);
    }
    for (const candidate of typewriterCandidates) {
      startTypewriter(candidate.message, candidate.item, candidate.body, { followBottom: stayAtBottom });
    }
    requestAnimationFrame(() => {
      if (stayAtBottom) {
        elements.scroll.scrollTop = elements.scroll.scrollHeight;
        clearUnread();
      } else restoreScrollAnchor(anchor);
    });
  }

  function mergeMessage(message) {
    const wasAwayFromBottom = !closeEnoughToBottom();
    const optimisticIndex = state.messages.findIndex((entry) => entry.clientNonce && entry.clientNonce === message.clientNonce);
    const exactIndex = state.messages.findIndex((entry) => entry.messageId === message.messageId);
    const index = exactIndex >= 0 ? exactIndex : optimisticIndex;
    if (index >= 0) state.messages[index] = { ...message, optimistic: optimisticIndex >= 0 };
    else {
      state.messages.push(message);
      if (shouldTypewriterMessage(message)) state.pendingTypewriterMessageIds.add(message.messageId);
    }
    state.messages.sort((a, b) => Number(a.seq || Number.MAX_SAFE_INTEGER) - Number(b.seq || Number.MAX_SAFE_INTEGER)
      || Number(a.createdAtMs) - Number(b.createdAtMs));
    renderMessages();
    if (index < 0 && wasAwayFromBottom) markUnread(1);
  }

  function reviveStoredFile(attachment) {
    let file = attachment.file;
    if (file instanceof Blob && !(file instanceof File)) {
      try {
        file = new File([file], attachment.name, {
          type: attachment.type,
          lastModified: attachment.lastModified,
        });
      } catch {}
    }
    return file;
  }

  function outboxDisplayAttachments(record) {
    return record.attachments.map((item) => {
      if (item.attachment) return item.attachment;
      if (!item.previewObjectUrl && item.file instanceof Blob && String(item.type || '').startsWith('image/')) {
        item.previewObjectUrl = URL.createObjectURL(item.file);
      }
      return {
        attachmentId: item.localId,
        mimeType: item.type,
        originalName: item.name,
        bytes: item.size,
        previewUrl: item.previewObjectUrl || '',
        originalUrl: item.previewObjectUrl || '',
        downloadUrl: item.previewObjectUrl || '',
        localOnly: true,
      };
    });
  }

  function outboxMessage(record, { sending = false } = {}) {
    return {
      messageId: `pending-${record.clientNonce}`,
      seq: Number.MAX_SAFE_INTEGER,
      authorId: 'james',
      author: { memberId: 'james', displayName: 'James' },
      body: record.body,
      attachments: outboxDisplayAttachments(record),
      clientNonce: record.clientNonce,
      createdAtMs: record.createdAtMs,
      pending: sending,
      queued: !sending,
      optimistic: true,
    };
  }

  function mergeOutboxMessages() {
    for (const record of state.outbox) {
      const matchingIndex = state.messages.findIndex((message) => message.clientNonce === record.clientNonce);
      if (matchingIndex < 0) state.messages.push(outboxMessage(record));
      else if (String(state.messages[matchingIndex].messageId || '').startsWith('pending-')) {
        state.messages[matchingIndex] = outboxMessage(record, { sending: state.drainingOutbox });
      }
    }
    state.messages.sort((a, b) => Number(a.seq || Number.MAX_SAFE_INTEGER) - Number(b.seq || Number.MAX_SAFE_INTEGER)
      || Number(a.createdAtMs) - Number(b.createdAtMs));
  }

  function applySnapshot(snapshot, { initial = false } = {}) {
    const nextMessages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    const previousIds = new Set(state.messages.map((message) => message.messageId));
    const newCount = nextMessages.filter((message) => !previousIds.has(message.messageId)).length;
    const wasAwayFromBottom = !initial && !closeEnoughToBottom();
    state.messages = nextMessages;
    mergeOutboxMessages();
    renderMessages({ forceBottom: initial });
    if (wasAwayFromBottom && newCount > 0) markUnread(newCount);
  }

  function connectSocket() {
    if (!state.authenticated) return;
    if (state.socket) { try { state.socket.close(); } catch {} }
    setConnection(state.connectedOnce ? 'disconnected' : 'connecting');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}/ws`);
    state.socket = socket;
    socket.addEventListener('open', () => {
      if (state.socket !== socket) return;
      state.reconnectAttempt = 0;
      setConnection('connected');
      sendPresence();
      clearInterval(state.presenceTimer);
      state.presenceTimer = setInterval(sendPresence, 45_000);
    });
    socket.addEventListener('message', (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.type === 'snapshot') applySnapshot(payload.snapshot);
      if (payload.type === 'message' && payload.message) mergeMessage(payload.message);
    });
    socket.addEventListener('close', () => {
      if (state.socket !== socket) return;
      state.socket = null;
      clearInterval(state.presenceTimer);
      state.presenceTimer = null;
      setConnection('disconnected');
      const waitMs = Math.min(15_000, 700 * (2 ** state.reconnectAttempt));
      state.reconnectAttempt += 1;
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connectSocket, waitMs);
    });
    socket.addEventListener('error', () => socket.close());
  }

  function sendPresence(focused = document.visibilityState === 'visible' && document.hasFocus()) {
    if (state.socket?.readyState !== WebSocket.OPEN) return;
    state.socket.send(JSON.stringify({ type: 'presence', focused: Boolean(focused) }));
  }

  function closeRoomOverflow() {
    elements.roomOverflow.open = false;
  }

  function updateRoomOverflow() {
    const actions = [
      elements.pairButton,
      elements.remotePairButton,
      elements.remoteAccessButton,
      elements.notificationButton,
    ];
    const hasVisibleAction = actions.some((button) => !button.hidden);
    elements.roomOverflow.hidden = !hasVisibleAction;
    if (!hasVisibleAction) closeRoomOverflow();
  }

  function showPairScreen() {
    state.authenticated = false;
    elements.pairScreen.hidden = false;
    elements.scroll.hidden = true;
    elements.composer.hidden = true;
    elements.pairButton.hidden = true;
    elements.remotePairButton.hidden = true;
    elements.remoteAccessButton.hidden = true;
    state.notifications.manageable = false;
    renderNotificationSettings();
    updateRoomOverflow();
    if (elements.notificationDialog.open) elements.notificationDialog.close();
    setConnection('disconnected');
  }

  function showRoom() {
    state.authenticated = true;
    elements.pairScreen.hidden = true;
    elements.scroll.hidden = false;
    elements.composer.hidden = false;
    elements.pairButton.hidden = true;
    elements.remotePairButton.hidden = true;
    elements.remoteAccessButton.hidden = true;
    void refreshNotificationSettings();
    updateRoomOverflow();
  }

  function updateSendState() {
    const hasContent = Boolean(elements.input.value.trim()) || state.attachments.length > 0;
    const queueable = state.attachments.every((item) => item.attachment || item.file instanceof Blob);
    elements.send.disabled = !state.authenticated || state.sending || !queueable || !hasContent;
    const attachmentPickerDisabled = !state.authenticated || state.sending || state.attachments.length >= maxAttachmentsPerMessage;
    elements.attachmentButton.disabled = attachmentPickerDisabled;
    elements.fileInput.disabled = attachmentPickerDisabled;
  }

  function resizeComposer() {
    elements.input.style.height = 'auto';
    elements.input.style.height = `${Math.min(180, elements.input.scrollHeight)}px`;
  }

  function attachmentStatusLabel(item) {
    if (item.status === 'ready') return item.attachment?.previewStatus === 'unavailable' ? 'Original ready · no preview' : 'Ready';
    if (item.status === 'uploading') return `${Math.max(1, Math.round(item.progress * 100))}%`;
    if (item.status === 'error') return item.error || 'Upload failed';
    if (item.status === 'canceled') return 'Canceled';
    return 'Waiting';
  }

  function localPreviewUrl(item) {
    if (!String(item.type || '').startsWith('image/') || !item.file) return null;
    if (!item.objectUrl) item.objectUrl = URL.createObjectURL(item.file);
    return item.objectUrl;
  }

  function attachmentCountLabel(items) {
    const count = items.length;
    if (count === 0) return '';
    const photosOnly = items.every((item) => String(item.type || item.attachment?.mimeType || '').toLowerCase().startsWith('image/'));
    const noun = photosOnly ? (count === 1 ? 'photo' : 'photos') : (count === 1 ? 'file' : 'files');
    return `${count} ${noun}`;
  }

  function renderUploadTray() {
    const keepBottom = closeEnoughToBottom();
    const countLabel = attachmentCountLabel(state.attachments);
    if (elements.uploadCount.textContent !== countLabel) elements.uploadCount.textContent = countLabel;
    elements.uploadCount.hidden = countLabel.length === 0;
    elements.uploadTray.replaceChildren();
    elements.uploadTray.hidden = state.attachments.length === 0;
    for (const item of state.attachments) {
      const card = document.createElement('article');
      card.className = 'upload-card';
      card.dataset.status = item.status;
      const preview = document.createElement('div');
      preview.className = 'upload-preview';
      const previewUrl = localPreviewUrl(item) || item.attachment?.previewUrl;
      if (previewUrl) {
        const image = document.createElement('img');
        image.src = previewUrl;
        image.alt = '';
        preview.append(image);
      } else {
        const extension = item.type === 'application/pdf' ? 'PDF' : 'FILE';
        preview.textContent = extension;
      }
      const copy = document.createElement('div');
      copy.className = 'upload-copy';
      const name = document.createElement('strong');
      name.title = item.name;
      name.textContent = item.name;
      const status = document.createElement('span');
      status.textContent = `${formatBytes(item.size)} · ${attachmentStatusLabel(item)}`;
      const progress = document.createElement('span');
      progress.className = 'upload-progress';
      const progressFill = document.createElement('span');
      progressFill.style.width = `${item.status === 'ready' ? 100 : Math.round((item.progress || 0) * 100)}%`;
      progress.append(progressFill);
      copy.append(name, status, progress);
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'upload-action';
      if (item.status === 'error' || item.status === 'canceled') {
        action.textContent = 'Retry';
        action.setAttribute('aria-label', `Retry ${item.name}`);
        action.addEventListener('click', () => retryAttachment(item));
      } else {
        action.textContent = '×';
        action.setAttribute('aria-label', item.status === 'uploading' ? `Cancel ${item.name}` : `Remove ${item.name}`);
        action.addEventListener('click', () => removeAttachment(item));
      }
      card.append(preview, copy, action);
      elements.uploadTray.append(card);
    }
    updateSendState();
    if (keepBottom) requestAnimationFrame(() => { elements.scroll.scrollTop = elements.scroll.scrollHeight; });
  }

  function announceUpload(message) {
    elements.uploadAnnouncements.textContent = '';
    requestAnimationFrame(() => { elements.uploadAnnouncements.textContent = message; });
  }

  function uploadErrorMessage(reason) {
    const value = String(reason || 'Upload failed');
    if (value.includes('attachment_too_large')) return 'File is too large';
    if (value.includes('attachment_mime_mismatch')) return 'File type does not match its contents';
    if (value.includes('attachment_magic_unsupported')) return 'That file type is not supported';
    if (value.includes('room_upload_aborted')) return 'Canceled';
    if (value.includes('room_attachment_preview')) return 'Original saved; preview unavailable';
    return 'Upload failed · tap retry';
  }

  function uploadAttachment(item) {
    if (item.removed || !state.authenticated || !item.file || ['uploading', 'ready'].includes(item.status)) return;
    if (!state.connected) {
      item.status = 'queued';
      item.progress = 0;
      item.error = null;
      void persistAttachment(item);
      renderUploadTray();
      return;
    }
    item.status = 'uploading';
    item.progress = Math.max(0.02, item.progress || 0);
    item.error = null;
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    void persistAttachment(item);
    renderUploadTray();
    xhr.open('POST', '/api/attachments');
    xhr.withCredentials = true;
    xhr.timeout = 5 * 60 * 1000;
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || item.removed) return;
      item.progress = Math.max(item.progress, Math.min(0.98, event.loaded / event.total));
      renderUploadTray();
    });
    const finish = (status, error = null, attachment = null) => {
      if (item.removed) return;
      item.xhr = null;
      item.status = status;
      item.error = error;
      item.attachment = attachment || item.attachment;
      item.progress = status === 'ready' ? 1 : item.progress;
      void persistAttachment(item);
      renderUploadTray();
    };
    xhr.addEventListener('load', () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && payload.ok && payload.attachment) {
        finish('ready', null, payload.attachment);
        announceUpload(`${item.name} is ready to send.`);
      } else {
        finish('error', uploadErrorMessage(payload.reason));
        announceUpload(`${item.name} could not be uploaded.`);
      }
    });
    xhr.addEventListener('error', () => finish('queued'));
    xhr.addEventListener('timeout', () => finish('queued'));
    xhr.addEventListener('abort', () => finish('canceled', 'Canceled'));
    const form = new FormData();
    form.append('file', item.file, item.name);
    xhr.send(form);
  }

  function retryAttachment(item) {
    if (item.removed) return;
    item.status = 'queued';
    item.progress = 0;
    item.error = null;
    void persistAttachment(item);
    renderUploadTray();
    uploadAttachment(item);
  }

  function removeAttachment(item) {
    item.removed = true;
    item.xhr?.abort();
    if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    state.attachments = state.attachments.filter((candidate) => candidate !== item);
    void deletePersistedAttachment(item.localId);
    renderUploadTray();
  }

  function supportedFile(file) {
    const mime = String(file.type || '').toLowerCase();
    const name = String(file.name || '').toLowerCase();
    return ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'application/pdf'].includes(mime)
      || /\.(jpe?g|png|gif|webp|heic|heif|avif|pdf)$/u.test(name);
  }

  async function stageFiles(fileList) {
    const files = [...(fileList || [])];
    if (files.length === 0) return;
    const available = maxAttachmentsPerMessage - state.attachments.length;
    const maxBytes = Number(state.config?.maxAttachmentBytes) || defaultMaxAttachmentBytes;
    for (const file of files.slice(0, Math.max(0, available))) {
      if (!supportedFile(file)) { announceUpload(`${file.name} is not a supported image or PDF.`); continue; }
      if (file.size <= 0 || file.size > maxBytes) { announceUpload(`${file.name} must be smaller than ${formatBytes(maxBytes)}.`); continue; }
      const localId = `draft-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
      const item = {
        localId,
        name: file.name || 'attachment',
        type: file.type || (/\.pdf$/iu.test(file.name) ? 'application/pdf' : 'application/octet-stream'),
        size: file.size,
        lastModified: file.lastModified,
        file,
        status: 'queued',
        progress: 0,
        attachment: null,
        error: null,
        createdAtMs: Date.now(),
      };
      state.attachments.push(item);
      await persistAttachment(item);
      renderUploadTray();
      uploadAttachment(item);
    }
    if (files.length > available) announceUpload(`A message can hold ${maxAttachmentsPerMessage} attachments.`);
  }

  async function restoreDraftAttachments() {
    if (state.restoredDrafts) return;
    state.restoredDrafts = true;
    const records = await withDraftStore('readonly', (store) => store.getAll());
    if (!Array.isArray(records)) return;
    state.attachments = records.slice(0, maxAttachmentsPerMessage).map((record) => {
      const file = reviveStoredFile(record);
      const interrupted = record.status === 'uploading' || record.status === 'queued';
      return {
        ...record,
        file,
        status: record.attachment ? 'ready' : interrupted ? 'queued' : record.status,
        progress: record.attachment ? 1 : interrupted ? 0 : Number(record.progress) || 0,
        xhr: null,
        removed: false,
      };
    });
    renderUploadTray();
  }

  function resumeDraftUploads() {
    for (const item of state.attachments) if (item.status === 'queued') uploadAttachment(item);
  }

  async function restoreOutbox() {
    if (state.restoredOutbox) return;
    state.restoredOutbox = true;
    const records = await withOutboxStore('readonly', (store) => store.getAll());
    if (!Array.isArray(records)) return;
    state.outbox = records.map((record) => ({
      ...record,
      body: String(record.body || ''),
      createdAtMs: Number(record.createdAtMs) || Date.now(),
      attachments: Array.isArray(record.attachments)
        ? record.attachments.map((attachment) => ({ ...attachment, file: reviveStoredFile(attachment) }))
        : [],
    })).sort((a, b) => a.createdAtMs - b.createdAtMs || a.clientNonce.localeCompare(b.clientNonce));
  }

  function setOutboxMessageState(record, sending) {
    const index = state.messages.findIndex((message) => message.clientNonce === record.clientNonce
      && String(message.messageId || '').startsWith('pending-'));
    if (index >= 0) state.messages[index] = outboxMessage(record, { sending });
    else if (!state.messages.some((message) => message.clientNonce === record.clientNonce)) {
      state.messages.push(outboxMessage(record, { sending }));
    }
    renderMessages();
  }

  async function uploadOutboxAttachment(item) {
    if (item.attachment) return item.attachment;
    if (!(item.file instanceof Blob)) throw new Error('room_outbox_attachment_blob_missing');
    const form = new FormData();
    form.append('file', item.file, item.name);
    const response = await fetch('/api/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (response.status === 401 || response.status === 403) {
      localStorage.removeItem(pairedDeviceKey);
      showPairScreen();
    }
    if (!response.ok || !payload.ok || !payload.attachment) {
      throw new Error(payload.reason || `room_outbox_attachment_http_${response.status}`);
    }
    item.attachment = payload.attachment;
    return item.attachment;
  }

  function scheduleOutboxDrain() {
    clearTimeout(state.outboxRetryTimer);
    if (!state.connected || !state.authenticated || state.outbox.length === 0) return;
    const waitMs = Math.min(15_000, 700 * (2 ** state.outboxRetryAttempt));
    state.outboxRetryAttempt += 1;
    state.outboxRetryTimer = setTimeout(() => { void drainOutbox(); }, waitMs);
  }

  async function drainOutbox() {
    if (state.drainingOutbox || !state.connected || !state.authenticated || state.outbox.length === 0) return;
    state.drainingOutbox = true;
    clearTimeout(state.outboxRetryTimer);
    state.outboxRetryTimer = null;
    try {
      while (state.connected && state.authenticated && state.outbox.length > 0) {
        const record = state.outbox[0];
        setOutboxMessageState(record, true);
        try {
          let changed = false;
          for (const attachment of record.attachments) {
            if (attachment.attachment) continue;
            await uploadOutboxAttachment(attachment);
            changed = true;
            if (await persistOutboxRecord(record) === null) throw new Error('room_outbox_attachment_checkpoint_failed');
          }
          if (changed && await persistOutboxRecord(record) === null) throw new Error('room_outbox_checkpoint_failed');
          const { response, payload } = await fetchJson('/api/messages', {
            method: 'POST',
            body: JSON.stringify({
              body: record.body,
              clientNonce: record.clientNonce,
              attachmentIds: record.attachments.map((item) => item.attachment?.attachmentId).filter(Boolean),
            }),
          });
          if (response.status === 401 || response.status === 403) {
            localStorage.removeItem(pairedDeviceKey);
            showPairScreen();
          }
          if (!response.ok || !payload.ok || !payload.message) {
            throw new Error(payload.reason || `room_outbox_message_http_${response.status}`);
          }
          mergeMessage(payload.message);
          if (await deleteOutboxRecord(record.clientNonce) === null) throw new Error('room_outbox_delete_failed');
          for (const attachment of record.attachments) {
            if (attachment.previewObjectUrl) URL.revokeObjectURL(attachment.previewObjectUrl);
          }
          state.outbox.shift();
          state.outboxRetryAttempt = 0;
        } catch {
          setOutboxMessageState(record, false);
          scheduleOutboxDrain();
          break;
        }
      }
    } finally {
      state.drainingOutbox = false;
    }
  }

  async function sendMessage() {
    const body = elements.input.value.trim();
    const selectedItems = [...state.attachments];
    if ((!body && selectedItems.length === 0) || state.sending) return;
    if (selectedItems.some((item) => !item.attachment && !(item.file instanceof Blob))) return;
    const clientNonce = `web-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    const record = {
      body,
      clientNonce,
      createdAtMs: Date.now(),
      attachments: selectedItems.map(serializableOutboxAttachment),
    };
    state.sending = true;
    elements.input.readOnly = true;
    updateSendState();
    try {
      if (await persistOutboxRecord(record) === null) {
        announceUpload('Could not save this message on the phone. Nothing was cleared.');
        return;
      }
      state.outbox.push(record);
      state.outbox.sort((a, b) => a.createdAtMs - b.createdAtMs || a.clientNonce.localeCompare(b.clientNonce));
      for (const item of selectedItems) {
        item.removed = true;
        item.xhr?.abort();
        if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
      }
      elements.input.value = '';
      localStorage.removeItem(draftKey);
      state.attachments = [];
      await clearPersistedAttachments();
      renderUploadTray();
      resizeComposer();
      mergeOutboxMessages();
      renderMessages({ forceBottom: true });
    } finally {
      state.sending = false;
      elements.input.readOnly = false;
      updateSendState();
      elements.input.focus();
    }
    void drainOutbox();
  }

  function resetLightboxTransform() {
    clearTimeout(state.lightbox.settleTimer);
    state.lightbox.settleTimer = null;
    delete elements.lightboxStage.dataset.settling;
    state.lightbox.scale = 1;
    state.lightbox.x = 0;
    state.lightbox.y = 0;
    state.lightbox.pointers.clear();
    state.lightbox.gesture = null;
    applyLightboxTransform();
  }

  function applyLightboxTransform() {
    elements.lightboxImage.style.transform = `translate3d(${state.lightbox.x}px, ${state.lightbox.y}px, 0) scale(${state.lightbox.scale})`;
  }

  function settleLightbox() {
    elements.lightboxStage.dataset.settling = 'true';
    clearTimeout(state.lightbox.settleTimer);
    state.lightbox.settleTimer = setTimeout(() => {
      delete elements.lightboxStage.dataset.settling;
      state.lightbox.settleTimer = null;
    }, 150);
  }

  function clampLightbox() {
    state.lightbox.scale = Math.max(1, Math.min(5, state.lightbox.scale));
    if (state.lightbox.scale === 1) { state.lightbox.x = 0; state.lightbox.y = 0; }
    const boundX = elements.lightboxStage.clientWidth * (state.lightbox.scale - 1) / 2;
    const boundY = elements.lightboxStage.clientHeight * (state.lightbox.scale - 1) / 2;
    state.lightbox.x = Math.max(-boundX, Math.min(boundX, state.lightbox.x));
    state.lightbox.y = Math.max(-boundY, Math.min(boundY, state.lightbox.y));
  }

  function pointerDistance(points) {
    return Math.hypot(points[0].clientX - points[1].clientX, points[0].clientY - points[1].clientY);
  }

  function pointerMidpoint(points) {
    return {
      x: (points[0].clientX + points[1].clientX) / 2,
      y: (points[0].clientY + points[1].clientY) / 2,
    };
  }

  function syncVisualViewport() {
    const preserveScroll = state.authenticated && !elements.scroll.hidden;
    const stayAtBottom = preserveScroll && closeEnoughToBottom();
    const anchor = preserveScroll && !stayAtBottom ? captureScrollAnchor() : null;
    const layoutHeight = Math.max(1, Number(window.innerHeight) || 1);
    const reportedHeight = Number(globalThis.visualViewport?.height);
    const visualHeight = Number.isFinite(reportedHeight) && reportedHeight > 0
      ? reportedHeight
      : layoutHeight;
    const reportedTop = Number(globalThis.visualViewport?.offsetTop);
    const viewportTop = Math.max(0, Math.round(Number.isFinite(reportedTop) ? reportedTop : 0));
    const viewportHeight = Math.max(1, Math.round(Math.min(layoutHeight, visualHeight)));
    const inputFocused = document.activeElement === elements.input;
    if (!inputFocused) state.viewportBaselineHeight = viewportHeight;
    const keyboardOpen = inputFocused
      && viewportHeight < Math.max(layoutHeight, state.viewportBaselineHeight) - 40;
    document.documentElement.dataset.roomKeyboardOpen = String(keyboardOpen);
    document.documentElement.style.setProperty('--room-viewport-top', `${viewportTop}px`);
    document.documentElement.style.setProperty('--room-viewport-height', `${viewportHeight}px`);
    if (preserveScroll) {
      if (stayAtBottom) elements.scroll.scrollTop = elements.scroll.scrollHeight;
      else restoreScrollAnchor(anchor);
    }
  }

  async function registerInstallShell() {
    if (!globalThis.isSecureContext || !('serviceWorker' in navigator)) return;
    try {
      state.serviceWorkerRegistration = await navigator.serviceWorker.register('/team-room-sw.js', { scope: '/' });
      return state.serviceWorkerRegistration;
    } catch {
      return null;
    }
  }

  function base64UrlBytes(value) {
    const normalized = String(value || '').replace(/-/gu, '+').replace(/_/gu, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function bytesEqual(left, right) {
    const a = left ? new Uint8Array(left) : new Uint8Array();
    const b = right ? new Uint8Array(right) : new Uint8Array();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function notificationEnvironment() {
    if (!state.config?.notifications?.available) {
      return { supported: false, guidance: 'Notifications are not available in this Team Room process yet.' };
    }
    if (!globalThis.isSecureContext || !('serviceWorker' in navigator)
      || !('PushManager' in globalThis) || !('Notification' in globalThis)) {
      return { supported: false, guidance: 'This browser does not support Team Room notifications.' };
    }
    const isIos = /iPad|iPhone|iPod/iu.test(navigator.userAgent || '');
    const standalone = globalThis.matchMedia?.('(display-mode: standalone)')?.matches
      || navigator.standalone === true;
    if (isIos && !standalone) {
      return { supported: false, guidance: 'On iPhone, add Team Room to your Home Screen first, then open that icon.' };
    }
    if (globalThis.Notification.permission === 'denied') {
      return { supported: false, guidance: 'Notifications are blocked in this phone’s settings.' };
    }
    return { supported: true, guidance: '' };
  }

  function renderNotificationSettings() {
    const current = state.notifications;
    elements.notificationButton.hidden = !current.manageable;
    elements.notificationButton.setAttribute('aria-pressed', String(current.enabled));
    elements.notificationButton.title = current.enabled ? 'Team Room notifications are on.' : 'Team Room notifications are off.';
    elements.notificationToggle.dataset.enabled = String(current.enabled);
    elements.notificationToggle.textContent = current.enabled ? 'Turn off notifications' : 'Enable notifications';
    elements.notificationToggle.disabled = current.pending || !current.supported;
    elements.notificationQuietHours.disabled = !current.enabled || current.pending;
    elements.notificationQuietStart.value = current.quietStart;
    elements.notificationQuietEnd.value = current.quietEnd;
    elements.notificationStatus.textContent = current.pending
      ? 'Working on this device…'
      : current.guidance
        ? current.guidance
        : current.enabled
          ? 'On. We only buzz for a real question, a decision that needs you, or a failure alert.'
          : 'Off. Nothing will ask for permission until you tap Enable.';
    updateRoomOverflow();
  }

  async function refreshNotificationSettings() {
    const environment = notificationEnvironment();
    state.notifications.supported = environment.supported;
    state.notifications.guidance = environment.guidance;
    if (!state.config?.notifications?.available || !state.authenticated) {
      state.notifications.manageable = false;
      renderNotificationSettings();
      return;
    }
    let response;
    let payload;
    try {
      ({ response, payload } = await fetchJson('/api/push/settings'));
    } catch {
      state.notifications.manageable = true;
      state.notifications.supported = false;
      state.notifications.guidance = 'Notification settings are temporarily unavailable.';
      renderNotificationSettings();
      return;
    }
    if (!payload.ok) {
      state.notifications.manageable = false;
      if (![401, 403].includes(response.status)) {
        state.notifications.manageable = true;
        state.notifications.supported = false;
        state.notifications.guidance = 'Notification settings are temporarily unavailable.';
      }
      renderNotificationSettings();
      return;
    }
    state.notifications.manageable = true;
    state.notifications.enabled = payload.settings?.enabled === true;
    state.notifications.quietStart = payload.settings?.quietStart || '23:30';
    state.notifications.quietEnd = payload.settings?.quietEnd || '07:30';
    renderNotificationSettings();
  }

  async function toggleNotifications() {
    if (!state.notifications.manageable || !state.notifications.supported || state.notifications.pending) return;
    state.notifications.pending = true;
    elements.notificationError.textContent = '';
    renderNotificationSettings();
    try {
      if (state.notifications.enabled) {
        const registration = state.serviceWorkerRegistration || await navigator.serviceWorker.ready;
        const removed = await fetchJson('/api/push/settings', { method: 'DELETE' });
        if (!removed.payload.ok) throw new Error(removed.payload.reason || 'Could not turn notifications off.');
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
        state.notifications.enabled = false;
      } else {
        // Safari requires this prompt to remain directly inside the user's click.
        const permission = await globalThis.Notification.requestPermission();
        if (permission !== 'granted') throw new Error('Notification permission was not granted.');
        const registration = state.serviceWorkerRegistration || await navigator.serviceWorker.ready;
        const applicationServerKey = base64UrlBytes(state.config.notifications.publicKey);
        let existing = await registration.pushManager.getSubscription();
        if (existing && !bytesEqual(existing.options?.applicationServerKey, applicationServerKey)) {
          await existing.unsubscribe();
          existing = null;
        }
        const subscription = existing || await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        const saved = await fetchJson('/api/push/settings', {
          method: 'POST',
          body: JSON.stringify({
            subscription: subscription.toJSON(),
            preferences: {
              quietStart: state.notifications.quietStart,
              quietEnd: state.notifications.quietEnd,
            },
          }),
        });
        if (!saved.payload.ok) {
          if (!existing) await subscription.unsubscribe();
          throw new Error(saved.payload.reason || 'Could not save this phone.');
        }
        state.notifications.enabled = true;
      }
    } catch (error) {
      elements.notificationError.textContent = error.message || 'Notification change failed.';
    } finally {
      const environment = notificationEnvironment();
      state.notifications.supported = environment.supported;
      state.notifications.guidance = environment.guidance;
      await refreshNotificationSettings();
      state.notifications.pending = false;
      renderNotificationSettings();
    }
  }

  async function saveQuietHours() {
    if (!state.notifications.enabled || state.notifications.pending) return;
    state.notifications.pending = true;
    elements.notificationError.textContent = '';
    state.notifications.quietStart = elements.notificationQuietStart.value;
    state.notifications.quietEnd = elements.notificationQuietEnd.value;
    renderNotificationSettings();
    try {
      const saved = await fetchJson('/api/push/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          preferences: {
            quietStart: state.notifications.quietStart,
            quietEnd: state.notifications.quietEnd,
          },
        }),
      });
      if (!saved.payload.ok) throw new Error(saved.payload.reason || 'Could not save quiet hours.');
    } catch (error) {
      elements.notificationError.textContent = error.message || 'Quiet hours were not saved.';
      await refreshNotificationSettings();
    } finally {
      state.notifications.pending = false;
      renderNotificationSettings();
    }
  }

  async function startPairing(mode = 'lan') {
    elements.pairDialogError.textContent = '';
    elements.pairQrShell.hidden = true;
    elements.pairQrImage.removeAttribute('src');
    const { payload } = await fetchJson('/api/pairing/start', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
    if (!payload.ok) {
      elements.pairDialogError.textContent = payload.reason === 'room_lan_disabled'
        ? 'Phone access is not enabled on this network.'
        : payload.reason || 'Could not start pairing.';
      elements.pairDialog.showModal();
      return;
    }
    const qrReady = /^data:image\/png;base64,/u.test(payload.pairing.qrDataUrl || '');
    elements.pairQrShell.hidden = !qrReady;
    elements.pairInstruction.textContent = qrReady
      ? mode === 'remote'
        ? 'On your phone, open Camera and scan. This pairs the private Tailscale address.'
        : 'On your phone, open Camera and scan. Tap the banner and you’re in.'
      : 'QR pairing is waiting for the Team Room runtime update. The address and code still work now.';
    if (qrReady) {
      elements.pairQrImage.src = payload.pairing.qrDataUrl;
      elements.pairQrImage.alt = `Scan to pair this phone with Team Room. Code ${payload.pairing.code}.`;
    } else {
      elements.pairQrImage.removeAttribute('src');
      elements.pairQrImage.alt = '';
    }
    elements.pairUrl.textContent = payload.pairing.claimUrl;
    elements.pairUrl.dataset.copyValue = payload.pairing.claimUrl;
    elements.pairCodeDisplay.textContent = payload.pairing.code.replace(/(\d{3})(\d{3})/u, '$1 $2');
    clearInterval(state.pairingExpiryTimer);
    const updateExpiry = () => {
      const remaining = Math.max(0, payload.pairing.expiresAtMs - Date.now());
      elements.pairExpiry.textContent = remaining > 0
        ? `One use · expires in ${Math.ceil(remaining / 60_000)} minute${remaining > 60_000 ? 's' : ''}.`
        : 'This code has expired. Close and make a new one.';
    };
    updateExpiry();
    state.pairingExpiryTimer = setInterval(updateExpiry, 15_000);
    elements.pairDialog.showModal();
  }

  function compactRemoteAccessDetail(value) {
    const compact = String(value || '').replace(/\s+/gu, ' ').trim();
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
  }

  function remoteAccessFailureMessage(remote = {}) {
    const reason = compactRemoteAccessDetail(remote.reason);
    const detail = compactRemoteAccessDetail(remote.detail);
    const evidence = `${reason} ${detail}`;
    if (/does not support getting tls certs|https certificates?/iu.test(evidence)) {
      return 'Enable HTTPS Certificates in the Tailscale DNS settings, then try again.';
    }
    const known = {
      tailscale_executable_not_found: 'Tailscale is not installed.',
      tailscale_not_connected: 'Sign in to Tailscale, then try again.',
      tailscale_node_offline: 'This computer is offline in Tailscale.',
      tailscale_serve_unrecognized_config: 'SquidRun could not verify the current Tailscale Serve route.',
      team_room_remote_target_not_loopback: 'The private Team Room listener is unavailable.',
    };
    return known[reason] || detail || reason || 'Remote access change failed.';
  }

  function renderRemoteAccess() {
    const remote = state.remoteAccess;
    elements.pairButton.hidden = !remote.manageable || state.config?.lanEnabled !== true;
    elements.remoteAccessButton.hidden = !remote.manageable;
    elements.remotePairButton.hidden = !remote.manageable || !remote.enabled;
    elements.remoteAccessButton.disabled = remote.pending;
    elements.remoteAccessButton.setAttribute('aria-pressed', String(remote.enabled));
    const stateLabel = remote.pending ? 'Working' : remote.enabled ? 'On' : remote.reason ? 'Error' : 'Off';
    const stateKey = remote.pending ? 'pending' : remote.enabled ? 'on' : remote.reason ? 'error' : 'off';
    const failureMessage = remote.reason ? remoteAccessFailureMessage(remote) : null;
    const visibleLabel = `Remote access: ${stateLabel}${failureMessage ? ` — ${failureMessage}` : ''}`;
    elements.remoteAccessLabel.textContent = visibleLabel;
    elements.remoteAccessButton.dataset.state = stateKey;
    elements.remoteAccessButton.setAttribute('aria-label', visibleLabel);
    elements.remoteAccessButton.title = failureMessage || (remote.enabled
      ? 'Turn off remote access. LAN Team Room stays running.'
      : 'Turn on private Tailscale access.');
    elements.roomOverflowState.hidden = !remote.manageable || !remote.enabled || remote.pending;
    elements.roomOverflowTrigger.setAttribute('aria-label', remote.manageable
      ? `Room options. Remote access ${stateLabel.toLowerCase()}.`
      : 'Room options');
    updateRoomOverflow();
  }

  async function refreshRemoteAccess() {
    const { response, payload } = await fetchJson('/api/remote-access');
    if (response.status === 401 || response.status === 403) {
      state.remoteAccess = { manageable: false, enabled: false, pending: false, reason: null, detail: null };
      renderRemoteAccess();
      return;
    }
    const disabled = payload.reason === 'tailscale_serve_disabled';
    state.remoteAccess = {
      manageable: true,
      enabled: payload.enabled === true,
      pending: payload.transitionPending === true,
      reason: payload.enabled === true || disabled ? null : payload.reason || null,
      detail: payload.enabled === true || disabled ? null : payload.detail || null,
    };
    renderRemoteAccess();
  }

  async function toggleRemoteAccess() {
    if (!state.remoteAccess.manageable || state.remoteAccess.pending) return;
    const enabled = !state.remoteAccess.enabled;
    state.remoteAccess.pending = true;
    state.remoteAccess.reason = null;
    renderRemoteAccess();
    const { payload } = await fetchJson('/api/remote-access', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    state.remoteAccess = {
      manageable: true,
      enabled: payload.ok === true && payload.enabled === true,
      pending: false,
      reason: payload.ok === true ? null : payload.reason || 'Remote access change failed.',
      detail: payload.ok === true ? null : payload.detail || null,
    };
    renderRemoteAccess();
  }

  function consumePairingCodeFromLocation() {
    const match = /^#pair=(\d{6})$/u.exec(location.hash);
    if (!match) return null;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return match[1];
  }

  async function submitPairingCode(code) {
    elements.pairError.textContent = '';
    const { payload } = await fetchJson('/api/pairing/claim', { method: 'POST', body: JSON.stringify({ code }) });
    if (!payload.ok) {
      elements.pairError.textContent = ['room_pairing_invalid', 'room_pairing_expired'].includes(payload.reason)
        ? 'That pairing link expired or was already used. Make a new QR code.'
        : payload.reason || 'That code did not work.';
      return false;
    }
    return true;
  }

  async function claimPairing(event) {
    event.preventDefault();
    const code = elements.pairCode.value.replace(/\D/gu, '');
    if (code.length !== 6) { elements.pairError.textContent = 'Enter all six digits.'; return; }
    if (!await submitPairingCode(code)) return;
    await initialize();
  }

  async function initialize() {
    try {
      const configResult = await fetchJson('/api/config');
      state.config = configResult.payload.config || {};
      const maxBytes = Number(state.config.maxAttachmentBytes) || defaultMaxAttachmentBytes;
      elements.attachmentHint.textContent = `Photos and PDFs · ${formatBytes(maxBytes)} each`;
      const { response, payload } = await fetchJson('/api/snapshot');
      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem(pairedDeviceKey);
        showPairScreen();
        if (state.pendingPairingCode) {
          const code = state.pendingPairingCode;
          state.pendingPairingCode = null;
          elements.pairCode.value = code;
          elements.pairError.textContent = 'Pairing securely…';
          if (await submitPairingCode(code)) await initialize();
        }
        return;
      }
      if (!payload.ok) throw new Error(payload.reason || 'room_snapshot_failed');
      showRoom();
      localStorage.setItem(pairedDeviceKey, '1');
      applySnapshot(payload.snapshot, { initial: true });
      connectSocket();
      resumeDraftUploads();
      void refreshRemoteAccess();
      elements.input.focus();
    } catch {
      if (localStorage.getItem(pairedDeviceKey) === '1') {
        showRoom();
        state.messages = [];
        mergeOutboxMessages();
        renderMessages({ forceBottom: true });
      }
      setConnection('disconnected');
      elements.banner.hidden = false;
    }
  }

  elements.composerForm.addEventListener('submit', (event) => { event.preventDefault(); void sendMessage(); });
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void sendMessage(); }
  });
  elements.input.addEventListener('input', () => {
    localStorage.setItem(draftKey, elements.input.value);
    resizeComposer();
    updateSendState();
  });
  elements.fileInput.addEventListener('change', () => { void stageFiles(elements.fileInput.files); elements.fileInput.value = ''; });
  document.addEventListener('dragenter', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files') || !state.authenticated) return;
    event.preventDefault();
    state.dragDepth += 1;
    elements.dropShield.hidden = false;
  });
  document.addEventListener('dragover', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', () => {
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) elements.dropShield.hidden = true;
  });
  document.addEventListener('drop', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault();
    state.dragDepth = 0;
    elements.dropShield.hidden = true;
    void stageFiles(event.dataTransfer.files);
  });
  elements.pairButton.addEventListener('click', () => { closeRoomOverflow(); void startPairing('lan'); });
  elements.remotePairButton.addEventListener('click', () => { closeRoomOverflow(); void startPairing('remote'); });
  elements.remoteAccessButton.addEventListener('click', () => { closeRoomOverflow(); void toggleRemoteAccess(); });
  elements.notificationButton.addEventListener('click', () => {
    closeRoomOverflow();
    elements.notificationError.textContent = '';
    void refreshNotificationSettings();
    elements.notificationDialog.showModal();
  });
  document.addEventListener('click', (event) => {
    if (elements.roomOverflow.open && !elements.roomOverflow.contains(event.target)) closeRoomOverflow();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && elements.roomOverflow.open) closeRoomOverflow();
  });
  elements.notificationDialogClose.addEventListener('click', () => elements.notificationDialog.close());
  elements.notificationDialog.addEventListener('click', (event) => {
    if (event.target === elements.notificationDialog) elements.notificationDialog.close();
  });
  elements.notificationToggle.addEventListener('click', () => { void toggleNotifications(); });
  elements.notificationQuietStart.addEventListener('change', () => { void saveQuietHours(); });
  elements.notificationQuietEnd.addEventListener('change', () => { void saveQuietHours(); });
  elements.pairForm.addEventListener('submit', (event) => { void claimPairing(event); });
  elements.pairUrl.addEventListener('click', async () => {
    const value = elements.pairUrl.dataset.copyValue || '';
    try {
      await navigator.clipboard.writeText(value);
      elements.pairUrl.textContent = 'Copied';
      setTimeout(() => { elements.pairUrl.textContent = value; }, 1000);
    } catch {}
  });
  elements.pairCode.addEventListener('input', () => {
    elements.pairCode.value = elements.pairCode.value.replace(/\D/gu, '').slice(0, 6);
  });
  elements.pairDialog.addEventListener('close', () => clearInterval(state.pairingExpiryTimer));
  elements.lightboxClose.addEventListener('click', () => elements.lightbox.close());
  elements.lightbox.addEventListener('click', (event) => { if (event.target === elements.lightbox) elements.lightbox.close(); });
  elements.lightbox.addEventListener('close', () => { elements.lightboxImage.removeAttribute('src'); resetLightboxTransform(); });
  elements.lightboxStage.addEventListener('wheel', (event) => {
    event.preventDefault();
    settleLightbox();
    const prior = state.lightbox.scale;
    state.lightbox.scale *= event.deltaY < 0 ? 1.18 : 0.84;
    clampLightbox();
    if (prior !== state.lightbox.scale) applyLightboxTransform();
  }, { passive: false });
  elements.lightboxStage.addEventListener('dblclick', () => {
    settleLightbox();
    state.lightbox.scale = state.lightbox.scale > 1 ? 1 : 2.5;
    state.lightbox.x = 0;
    state.lightbox.y = 0;
    applyLightboxTransform();
  });
  elements.lightboxStage.addEventListener('pointerdown', (event) => {
    elements.lightboxStage.setPointerCapture(event.pointerId);
    state.lightbox.pointers.set(event.pointerId, event);
    const points = [...state.lightbox.pointers.values()];
    if (points.length === 2) {
      const center = pointerMidpoint(points);
      const rect = elements.lightboxStage.getBoundingClientRect();
      state.lightbox.gesture = {
        distance: pointerDistance(points),
        scale: state.lightbox.scale,
        originX: (center.x - rect.left - rect.width / 2 - state.lightbox.x) / state.lightbox.scale,
        originY: (center.y - rect.top - rect.height / 2 - state.lightbox.y) / state.lightbox.scale,
      };
    } else {
      state.lightbox.gesture = { clientX: event.clientX, clientY: event.clientY, x: state.lightbox.x, y: state.lightbox.y };
    }
  });
  elements.lightboxStage.addEventListener('pointermove', (event) => {
    if (!state.lightbox.pointers.has(event.pointerId)) return;
    state.lightbox.pointers.set(event.pointerId, event);
    const points = [...state.lightbox.pointers.values()];
    if (points.length === 2 && state.lightbox.gesture?.distance) {
      state.lightbox.scale = state.lightbox.gesture.scale * (pointerDistance(points) / state.lightbox.gesture.distance);
      const center = pointerMidpoint(points);
      const rect = elements.lightboxStage.getBoundingClientRect();
      state.lightbox.x = center.x - rect.left - rect.width / 2 - state.lightbox.gesture.originX * state.lightbox.scale;
      state.lightbox.y = center.y - rect.top - rect.height / 2 - state.lightbox.gesture.originY * state.lightbox.scale;
    } else if (points.length === 1 && state.lightbox.scale > 1 && state.lightbox.gesture?.clientX !== undefined) {
      state.lightbox.x = state.lightbox.gesture.x + event.clientX - state.lightbox.gesture.clientX;
      state.lightbox.y = state.lightbox.gesture.y + event.clientY - state.lightbox.gesture.clientY;
    }
    clampLightbox();
    applyLightboxTransform();
  });
  const releasePointer = (event) => {
    state.lightbox.pointers.delete(event.pointerId);
    const remaining = [...state.lightbox.pointers.values()];
    state.lightbox.gesture = remaining.length === 1
      ? { clientX: remaining[0].clientX, clientY: remaining[0].clientY, x: state.lightbox.x, y: state.lightbox.y }
      : null;
    clampLightbox();
    applyLightboxTransform();
  };
  elements.lightboxStage.addEventListener('pointerup', releasePointer);
  elements.lightboxStage.addEventListener('pointercancel', releasePointer);
  elements.unreadMarker.addEventListener('click', () => {
    clearUnread();
    elements.scroll.scrollTo({ top: elements.scroll.scrollHeight, behavior: 'auto' });
  });
  elements.scroll.addEventListener('scroll', () => { if (closeEnoughToBottom()) clearUnread(); }, { passive: true });
  window.addEventListener('online', () => {
    if (!state.socket) connectSocket();
    resumeDraftUploads();
    void drainOutbox();
  });
  window.addEventListener('focus', () => sendPresence(true));
  window.addEventListener('blur', () => sendPresence(false));
  document.addEventListener('visibilitychange', () => sendPresence());
  window.addEventListener('resize', syncVisualViewport, { passive: true });
  globalThis.visualViewport?.addEventListener('resize', syncVisualViewport, { passive: true });
  globalThis.visualViewport?.addEventListener('scroll', syncVisualViewport, { passive: true });
  window.addEventListener('beforeunload', () => {
    clearTimeout(state.reconnectTimer);
    clearTimeout(state.outboxRetryTimer);
    clearInterval(state.presenceTimer);
    sendPresence(false);
    finishActiveTypewriters();
    state.socket?.close();
    for (const item of state.attachments) if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    for (const record of state.outbox) {
      for (const attachment of record.attachments) {
        if (attachment.previewObjectUrl) URL.revokeObjectURL(attachment.previewObjectUrl);
      }
    }
  });
  reducedMotionQuery?.addEventListener?.('change', (event) => {
    if (!event.matches) return;
    state.pendingTypewriterMessageIds.clear();
    finishActiveTypewriters();
  });

  async function boot() {
    syncVisualViewport();
    state.pendingPairingCode = consumePairingCodeFromLocation();
    await registerInstallShell();
    elements.input.value = localStorage.getItem(draftKey) || '';
    resizeComposer();
    await restoreOutbox();
    await restoreDraftAttachments();
    updateSendState();
    await initialize();
  }

  void boot();
})();
