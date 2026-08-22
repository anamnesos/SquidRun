'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { TeamRoomRuntime } = require('../../modules/main/team-room-runtime');
const { createTeamRoomWindow } = require('../../modules/main/team-room-window');

const outputPath = path.resolve(String(process.env.TEAM_ROOM_PHASE_D_OUTPUT || ''));
const desktopScreenshotPath = String(process.env.TEAM_ROOM_PHASE_D_DESKTOP_SCREENSHOT || '').trim();
const phoneScreenshotPath = String(process.env.TEAM_ROOM_PHASE_D_PHONE_SCREENSHOT || '').trim();
const keyboardScreenshotPath = String(process.env.TEAM_ROOM_PHASE_D_KEYBOARD_SCREENSHOT || '').trim();
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-phase-d-browser-'));
app.setPath('userData', path.join(smokeRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});

function checkpoint(stage, details = {}) {
  if (!process.env.TEAM_ROOM_PHASE_D_OUTPUT) return;
  fs.writeFileSync(outputPath, `${JSON.stringify({ complete: false, stage, ...details }, null, 2)}\n`, 'utf8');
}

checkpoint('module-loaded', { smokeRoot });

function bindings(appGeneration, builderLaunchId) {
  return {
    ok: true,
    bindings: Object.fromEntries(['architect', 'builder', 'oracle'].map((role, index) => [role, {
      role,
      paneId: String(index + 1),
      profileName: 'main',
      paneLaunchId: role === 'builder' ? builderLaunchId : `pl_${String(index + 1).repeat(32)}`,
      appGeneration,
    }])),
  };
}

function requestJson(origin, route, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const request = http.request(new URL(route, origin), {
      method: options.method || 'GET',
      headers: {
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.authorization ? { Authorization: options.authorization } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload = {};
        try { payload = JSON.parse(text); } catch {}
        resolve({ statusCode: response.statusCode, payload, headers: response.headers });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function waitForRenderer(windowRef, predicate, timeoutMs = 12_000, label = 'unnamed') {
  return windowRef.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + ${Number(timeoutMs)};
    while (Date.now() < deadline) {
      const value = (${predicate})();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    throw new Error('phase_d_renderer_wait_timeout:${String(label)}');
  })()`);
}

function runtimeOptions(port, resolveBindings) {
  return {
    appGeneration: `app-session-${String(process.pid)}`,
    projectRoot: smokeRoot,
    publicRoot: path.resolve(__dirname, '..', '..'),
    runtimeRoot: path.join(smokeRoot, '.squidrun', 'runtime', 'team-room'),
    host: '127.0.0.1',
    port,
    lanEnabled: false,
    allowedOrigins: [],
    storeOptions: {
      dbPath: path.join(smokeRoot, 'room', 'room.db'),
      attachmentRoot: path.join(smokeRoot, 'room', 'attachments'),
    },
    deliverToPane: async () => ({ ok: true }),
    resolveCliBindings: resolveBindings,
  };
}

async function run() {
  if (!process.env.TEAM_ROOM_PHASE_D_OUTPUT) throw new Error('TEAM_ROOM_PHASE_D_OUTPUT_required');
  let builderLaunchId = `pl_${'2'.repeat(32)}`;
  const resolveBindings = ({ appGeneration }) => bindings(appGeneration, builderLaunchId);
  let runtime = new TeamRoomRuntime(runtimeOptions(0, resolveBindings));
  let windowRef = null;
  let result = null;
  let debuggerAttached = false;
  const consoleErrors = [];

  try {
    const firstStart = await runtime.start();
    if (!firstStart.ok) throw new Error(firstStart.reason);
    checkpoint('runtime-started', { origin: firstStart.origin });
    const fixedPort = runtime.server.address().port;
    const paired = runtime._issueCredential('james', 'room_web', 'paired_device', {
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });
    if (!paired.ok) throw new Error(paired.reason);
    const cookie = `squidrun_team_room=${paired.token}`;

    for (let index = 1; index <= 36; index += 1) {
      const posted = await requestJson(firstStart.origin, '/api/messages', {
        method: 'POST',
        cookie,
        origin: firstStart.origin,
        body: {
          body: `Recovery baseline ${index}. Keep the stream anchored while new work arrives.`,
          clientNonce: `phase-d-seed-${index}`,
        },
      });
      if (posted.statusCode !== 201) throw new Error(`phase_d_seed_failed:${index}:${posted.payload.reason}`);
    }
    checkpoint('messages-seeded');

    const created = await createTeamRoomWindow({
      BrowserWindow,
      origin: firstStart.origin,
      credentialToken: paired.token,
      statePath: path.join(smokeRoot, 'window-state.json'),
      showOnReady: false,
      windowOptions: { width: 1180, height: 820, minWidth: 320, minHeight: 480 },
    });
    windowRef = created.window;
    windowRef.webContents.on('console-message', (_event, level, message) => {
      if (Number(level) >= 2) consoleErrors.push(String(message));
    });
    await waitForRenderer(windowRef, `() => document.querySelector('#connectionDot')?.dataset.state === 'connected'
      && document.querySelectorAll('.message-item').length >= 36`, 12_000, 'initial-connect');
    checkpoint('window-connected');

    const installShell = await windowRef.webContents.executeJavaScript(`(async () => {
      const manifestLink = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
      const manifestResponse = await fetch(manifestLink);
      const manifest = await manifestResponse.json();
      const iconChecks = await Promise.all(manifest.icons.map(async (icon) => {
        const response = await fetch(icon.src);
        return { src: icon.src, ok: response.ok, type: response.headers.get('content-type') };
      }));
      let serviceWorker = 'unsupported';
      if ('serviceWorker' in navigator && globalThis.isSecureContext) {
        const registration = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
        ]);
        serviceWorker = registration?.active?.state || 'not-ready';
      }
      return {
        manifestLink,
        name: manifest.name,
        display: manifest.display,
        iconChecks,
        serviceWorker,
        appleTouchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
      };
    })()`);
    checkpoint('install-shell-verified', installShell);

    const beforeDrop = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      scroll.scrollTop = Math.max(1, Math.floor((scroll.scrollHeight - scroll.clientHeight) / 3));
      const scrollRect = scroll.getBoundingClientRect();
      const anchor = [...document.querySelectorAll('.message-item')]
        .find((item) => item.getBoundingClientRect().bottom >= scrollRect.top + 1);
      return {
        scrollTop: scroll.scrollTop,
        bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        anchorId: anchor?.dataset.messageId || null,
        anchorOffset: anchor ? anchor.getBoundingClientRect().top - scrollRect.top : null,
      };
    })()`);
    for (const client of runtime.clients) client.terminate();
    await waitForRenderer(windowRef, `() => document.querySelector('#connectionDot')?.dataset.state === 'disconnected'`, 12_000, 'socket-drop');
    const missedDuringDrop = await requestJson(firstStart.origin, '/api/messages', {
      method: 'POST', cookie, origin: firstStart.origin,
      body: { body: 'Arrived while the WebSocket was down.', clientNonce: 'phase-d-ws-catchup' },
    });
    if (missedDuringDrop.statusCode !== 201) throw new Error('phase_d_ws_catchup_post_failed');
    await waitForRenderer(windowRef, `() => document.querySelector('#connectionDot')?.dataset.state === 'connected'
      && !document.querySelector('#unreadMarker')?.hidden
      && document.querySelector('#messageColumn')?.innerText.includes('Arrived while the WebSocket was down.')`, 12_000, 'socket-resume-unread');
    checkpoint('socket-resumed');
    const afterResume = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      const scrollRect = scroll.getBoundingClientRect();
      const anchor = document.querySelector('.message-item[data-message-id="${beforeDrop.anchorId}"]');
      return {
        scrollTop: scroll.scrollTop,
        bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        anchorId: anchor?.dataset.messageId || null,
        anchorOffset: anchor ? anchor.getBoundingClientRect().top - scrollRect.top : null,
        unreadLabel: document.querySelector('#unreadMarkerLabel')?.textContent,
      };
    })()`);
    await windowRef.webContents.executeJavaScript(`document.querySelector('#unreadMarker').click()`);
    await waitForRenderer(windowRef, `() => document.querySelector('#unreadMarker')?.hidden
      && document.querySelector('#messageScroll').scrollHeight
        - document.querySelector('#messageScroll').scrollTop
        - document.querySelector('#messageScroll').clientHeight < 3`, 12_000, 'unread-jump');

    const optimistic = await windowRef.webContents.executeJavaScript(`(async () => {
      const input = document.querySelector('#messageInput');
      input.value = 'Optimistic send resolves exactly once.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const items = [...document.querySelectorAll('.message-item')]
          .filter((item) => item.innerText.includes('Optimistic send resolves exactly once.'));
        if (items.length === 1 && !items[0].dataset.pending && items[0].querySelector('.message-meta')?.innerText.includes('Sent')) {
          return { count: items.length, pending: false, meta: items[0].querySelector('.message-meta').innerText };
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error('optimistic_resolution_timeout');
    })()`);
    checkpoint('optimistic-resolved', optimistic);

    await windowRef.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = 'Draft survives a full Team Room server restart.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await runtime.stop();
    await waitForRenderer(windowRef, `() => document.querySelector('#connectionDot')?.dataset.state === 'disconnected'`, 12_000, 'server-stop');
    runtime = new TeamRoomRuntime(runtimeOptions(fixedPort, resolveBindings));
    const secondStart = await runtime.start();
    if (!secondStart.ok || secondStart.origin !== firstStart.origin) throw new Error('phase_d_fixed_port_restart_failed');
    const restartCatchup = await requestJson(secondStart.origin, '/api/messages', {
      method: 'POST', cookie, origin: secondStart.origin,
      body: { body: 'Server restart catch-up is authoritative.', clientNonce: 'phase-d-server-restart-catchup' },
    });
    if (restartCatchup.statusCode !== 201) throw new Error('phase_d_restart_catchup_post_failed');
    await waitForRenderer(windowRef, `() => document.querySelector('#connectionDot')?.dataset.state === 'connected'
      && document.querySelector('#messageColumn')?.innerText.includes('Server restart catch-up is authoritative.')`, 12_000, 'server-restart-catchup');
    checkpoint('server-restarted');
    const afterServerRestart = await windowRef.webContents.executeJavaScript(`(() => ({
      connected: document.querySelector('#connectionDot').dataset.state,
      draft: document.querySelector('#messageInput').value,
      catchupPresent: document.querySelector('#messageColumn').innerText.includes('Server restart catch-up is authoritative.'),
    }))()`);

    const interruptedDraftSeeded = await windowRef.webContents.executeJavaScript(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 240;
      canvas.height = 150;
      const context = canvas.getContext('2d');
      const gradient = context.createLinearGradient(0, 0, 240, 150);
      gradient.addColorStop(0, '#173f52');
      gradient.addColorStop(1, '#1a6e58');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 240, 150);
      context.fillStyle = '#e8edf2';
      context.font = '600 22px sans-serif';
      context.fillText('PHASE D', 70, 84);
      const imageBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const imageFile = new File([imageBlob], 'phase-d-recovery-photo.png', { type: 'image/png', lastModified: Date.now() });
      const pdfFile = new File(['%PDF-1.4\\n1 0 obj<</Type/Catalog>>endobj\\n%%EOF'], 'phase-d-recovery.pdf', { type: 'application/pdf', lastModified: Date.now() });
      const records = [
        { localId: 'phase-d-draft-image', name: imageFile.name, type: imageFile.type, size: imageFile.size, lastModified: imageFile.lastModified, file: imageFile },
        { localId: 'phase-d-draft-pdf', name: pdfFile.name, type: pdfFile.type, size: pdfFile.size, lastModified: pdfFile.lastModified, file: pdfFile },
      ];
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('squidrun-team-room-drafts-v1', 2);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('attachments')) request.result.createObjectStore('attachments', { keyPath: 'localId' });
          if (!request.result.objectStoreNames.contains('outbox')) request.result.createObjectStore('outbox', { keyPath: 'clientNonce' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('attachments', 'readwrite');
        for (const record of records) transaction.objectStore('attachments').put({
          ...record,
          status: 'uploading',
          progress: .47,
          attachment: null,
          error: null,
          createdAtMs: Date.now(),
        });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      localStorage.setItem('squidrun.team-room.draft.v1', 'Recovered after an interrupted upload.');
      return records.map((record) => ({ name: record.name, bytes: record.size }));
    })()`);
    checkpoint('interrupted-draft-seeded');
    windowRef.webContents.reload();
    await waitForRenderer(windowRef, `() => document.querySelector('#connectionDot')?.dataset.state === 'connected'
      && document.querySelectorAll('.upload-card[data-status="ready"]').length === 2
      && document.querySelector('#messageInput')?.value === 'Recovered after an interrupted upload.'`, 20_000, 'interrupted-upload-restore');
    const recoveredDraft = await windowRef.webContents.executeJavaScript(`(() => ({
      readyCards: document.querySelectorAll('.upload-card[data-status="ready"]').length,
      attachmentCount: document.querySelector('#uploadCount')?.textContent,
      attachmentCountVisible: !document.querySelector('#uploadCount')?.hidden,
      draft: document.querySelector('#messageInput').value,
      sendEnabled: !document.querySelector('#sendButton').disabled,
    }))()`);
    checkpoint('interrupted-draft-restored', recoveredDraft);
    await windowRef.webContents.executeJavaScript(`document.querySelector('#sendButton').click()`);
    await waitForRenderer(windowRef, `() => document.querySelectorAll('.message-attachments .media-tile').length >= 1
      && document.querySelectorAll('.message-attachments .file-tile').length >= 1
      && document.querySelector('#uploadTray')?.hidden
      && document.querySelector('#uploadCount')?.hidden`, 15_000, 'attachment-send');
    const attachmentPresentation = await windowRef.webContents.executeJavaScript(`(() => {
      const media = [...document.querySelectorAll('.media-tile')].at(-1);
      const file = [...document.querySelectorAll('.file-tile')].at(-1);
      const caption = media.querySelector('.media-caption');
      const filename = file.querySelector('strong');
      media.click();
      return {
        imageCaption: caption.textContent,
        imageCaptionOpacity: Number(getComputedStyle(caption).opacity),
        fileName: filename.textContent,
        fileNameOpacity: Number(getComputedStyle(filename).opacity),
        fileNameVisible: filename.getBoundingClientRect().width > 0,
      };
    })()`);
    checkpoint('attachments-sent', attachmentPresentation);
    await waitForRenderer(windowRef, `() => document.querySelector('#mediaLightbox')?.open
      && document.querySelector('#lightboxImage')?.naturalWidth > 0`, 12_000, 'lightbox-open');
    const pinchZoom = await windowRef.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('#lightboxStage');
      stage.setPointerCapture = () => {};
      const rect = stage.getBoundingClientRect();
      const emit = (type, pointerId, clientX, clientY) => stage.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId, clientX, clientY, pointerType: 'touch', isPrimary: pointerId === 1,
      }));
      emit('pointerdown', 1, rect.left + rect.width * .42, rect.top + rect.height * .50);
      emit('pointerdown', 2, rect.left + rect.width * .58, rect.top + rect.height * .50);
      emit('pointermove', 1, rect.left + rect.width * .30, rect.top + rect.height * .43);
      emit('pointermove', 2, rect.left + rect.width * .74, rect.top + rect.height * .57);
      const transformAfterPinch = document.querySelector('#lightboxImage').style.transform;
      emit('pointerup', 2, rect.left + rect.width * .74, rect.top + rect.height * .57);
      emit('pointermove', 1, rect.left + rect.width * .34, rect.top + rect.height * .47);
      emit('pointerup', 1, rect.left + rect.width * .34, rect.top + rect.height * .47);
      const transformAfterPan = document.querySelector('#lightboxImage').style.transform;
      stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return {
        transformAfterPinch,
        transformAfterPan,
        settling: stage.dataset.settling,
        transitionDuration: getComputedStyle(document.querySelector('#lightboxImage')).transitionDuration,
      };
    })()`);
    checkpoint('lightbox-verified', pinchZoom);
    await windowRef.webContents.executeJavaScript(`document.querySelector('#mediaLightbox').close()`);

    const photoCounterFlow = await windowRef.webContents.executeJavaScript(`(async () => {
      const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
      const waitUntil = async (predicate, label) => {
        const deadline = Date.now() + 12_000;
        while (!predicate() && Date.now() < deadline) await pause();
        if (!predicate()) throw new Error('photo_counter_timeout:' + label);
      };
      const canvas = document.createElement('canvas');
      canvas.width = 12;
      canvas.height = 12;
      canvas.getContext('2d').fillRect(0, 0, 12, 12);
      const imageBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const photos = Array.from({ length: 5 }, (_, index) => new File(
        [imageBlob],
        'counter-photo-' + (index + 1) + '.png',
        { type: 'image/png', lastModified: Date.now() + index },
      ));
      const select = (files) => {
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(file);
        const input = document.querySelector('#fileInput');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      select(photos.slice(0, 1));
      await waitUntil(() => document.querySelector('#uploadCount')?.textContent === '1 photo', 'one-photo');
      const onePhoto = document.querySelector('#uploadCount').textContent;
      select(photos.slice(1));
      await waitUntil(() => document.querySelector('#uploadCount')?.textContent === '5 photos', 'five-photos');
      const fivePhotos = document.querySelector('#uploadCount').textContent;
      await waitUntil(() => document.querySelectorAll('.upload-card[data-status="ready"]').length === 5, 'five-ready');
      while (document.querySelector('.upload-action')) {
        document.querySelector('.upload-action').click();
        await pause();
      }
      await waitUntil(() => document.querySelector('#uploadCount')?.hidden === true, 'counter-hidden');
      return {
        onePhoto,
        fivePhotos,
        hiddenAfterRemoval: document.querySelector('#uploadCount').hidden,
        trayHiddenAfterRemoval: document.querySelector('#uploadTray').hidden,
      };
    })()`);
    checkpoint('photo-counter-verified', photoCounterFlow);

    const singleChooser = await windowRef.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('#attachmentButton');
      const picker = document.querySelector('#fileInput');
      const triggerRect = trigger.getBoundingClientRect();
      const pickerRect = picker.getBoundingClientRect();
      const hitTarget = document.elementFromPoint(
        triggerRect.left + (triggerRect.width / 2),
        triggerRect.top + (triggerRect.height / 2),
      );
      const beforeCancelCards = document.querySelectorAll('.upload-card').length;
      const emptyTransfer = new DataTransfer();
      picker.files = emptyTransfer.files;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        directHitTarget: hitTarget === picker,
        visibleSourceRect: pickerRect.width > 0 && pickerRect.height > 0,
        alignedToButton: Math.abs(pickerRect.left - triggerRect.left) <= 1
          && Math.abs(pickerRect.top - triggerRect.top) <= 1
          && Math.abs(pickerRect.width - triggerRect.width) <= 1
          && Math.abs(pickerRect.height - triggerRect.height) <= 1,
        hiddenAttribute: picker.hasAttribute('hidden'),
        customMenuCount: document.querySelectorAll('.attachment-menu').length,
        captureInputCount: document.querySelectorAll('input[capture]').length,
        multiple: picker.multiple,
        cancelNoop: document.querySelectorAll('.upload-card').length === beforeCancelCards,
      };
    })()`);
    checkpoint('single-chooser-verified', singleChooser);

    await runtime.stop();
    await waitForRenderer(windowRef, `() => document.querySelector('#connectionDot')?.dataset.state === 'disconnected'`, 12_000, 'outbox-server-off');
    const queuedOffline = await windowRef.webContents.executeJavaScript(`(async () => {
      const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
      const waitUntil = async (predicate, label, timeoutMs = 12_000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate() && Date.now() < deadline) await pause();
        if (!predicate()) throw new Error('outbox_queue_timeout:' + label);
      };
      const sendText = async (text) => {
        const input = document.querySelector('#messageInput');
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await waitUntil(() => !document.querySelector('#sendButton').disabled, 'send-enabled-' + text);
        document.querySelector('#sendButton').click();
        await waitUntil(() => [...document.querySelectorAll('.message-item[data-queued="true"]')]
          .some((item) => item.innerText.includes(text)), 'queued-' + text);
      };
      await sendText('Offline FIFO first.');
      await sendText('Offline FIFO second.');

      const canvas = document.createElement('canvas');
      canvas.width = 24;
      canvas.height = 18;
      canvas.getContext('2d').fillRect(0, 0, 24, 18);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'offline-outbox-photo.png', { type: 'image/png', lastModified: Date.now() });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const picker = document.querySelector('#fileInput');
      picker.files = transfer.files;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await waitUntil(() => document.querySelector('.upload-card[data-status="queued"]'), 'offline-photo-staged');
      await sendText('Offline attachment third.');

      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('squidrun-team-room-drafts-v1', 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const outbox = await new Promise((resolve, reject) => {
        const request = database.transaction('outbox', 'readonly').objectStore('outbox').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return {
        connected: document.querySelector('#connectionDot').dataset.state,
        queuedLabels: [...document.querySelectorAll('.message-item[data-queued="true"] .message-meta')].map((item) => item.innerText.trim()),
        records: outbox.sort((a, b) => a.createdAtMs - b.createdAtMs).map((record) => ({
          clientNonce: record.clientNonce,
          body: record.body,
          attachmentCount: record.attachments.length,
          attachmentBytes: record.attachments[0]?.file?.size || 0,
        })),
        draftCleared: document.querySelector('#messageInput').value === '' && document.querySelector('#uploadTray').hidden,
      };
    })()`);
    checkpoint('outbox-queued-server-off', queuedOffline);

    windowRef.destroy();
    windowRef = null;
    checkpoint('outbox-window-closed');
    await new Promise((resolve) => setTimeout(resolve, 180));
    runtime = new TeamRoomRuntime(runtimeOptions(fixedPort, resolveBindings));
    const outboxRestart = await runtime.start();
    checkpoint('outbox-runtime-restarted', { ok: outboxRestart.ok, origin: outboxRestart.origin });
    if (!outboxRestart.ok || outboxRestart.origin !== firstStart.origin) throw new Error('phase_d_outbox_restart_failed');
    const outboxHealth = await requestJson(outboxRestart.origin, '/api/config', { cookie, origin: outboxRestart.origin });
    checkpoint('outbox-runtime-healthy', { statusCode: outboxHealth.statusCode, ok: outboxHealth.payload.ok });
    if (outboxHealth.statusCode !== 200 || !outboxHealth.payload.ok) throw new Error('phase_d_outbox_restart_health_failed');
    await new Promise((resolve) => setTimeout(resolve, 180));
    const reopened = await createTeamRoomWindow({
      BrowserWindow,
      origin: outboxRestart.origin,
      credentialToken: paired.token,
      statePath: path.join(smokeRoot, 'window-state.json'),
      showOnReady: false,
      windowOptions: { width: 1180, height: 820, minWidth: 320, minHeight: 480 },
    });
    checkpoint('outbox-window-reopened');
    windowRef = reopened.window;
    windowRef.webContents.on('console-message', (_event, level, message) => {
      if (Number(level) >= 2) consoleErrors.push(String(message));
    });
    await waitForRenderer(windowRef, `() => {
      const expected = ['Offline FIFO first.', 'Offline FIFO second.', 'Offline attachment third.'];
      const messages = [...document.querySelectorAll('.message-item')];
      return document.querySelector('#connectionDot')?.dataset.state === 'connected'
        && expected.every((body) => {
          const matching = messages.filter((item) => item.querySelector('.message-body')?.innerText === body);
          return matching.length === 1
            && matching[0].dataset.queued !== 'true'
            && matching[0].dataset.pending !== 'true'
            && matching[0].querySelector('.message-meta')?.innerText.includes('Sent');
        });
    }`, 25_000, 'outbox-reopen-drain');
    const outboxAfterReopen = await windowRef.webContents.executeJavaScript(`(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('squidrun-team-room-drafts-v1', 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count = await new Promise((resolve, reject) => {
        const request = database.transaction('outbox', 'readonly').objectStore('outbox').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return { count, connected: document.querySelector('#connectionDot').dataset.state };
    })()`);
    const queuedBodies = queuedOffline.records.map((record) => record.body);
    const canonicalQueued = runtime.store.listMessages().filter((message) => queuedBodies.includes(message.body));
    const outboxFlow = {
      ...outboxAfterReopen,
      canonicalCounts: Object.fromEntries(queuedBodies.map((body) => [body, canonicalQueued.filter((message) => message.body === body).length])),
      seqs: canonicalQueued.map((message) => message.seq),
      activationCounts: canonicalQueued.map((message) => runtime.store.listActivations(message.messageId).length),
      attachmentCounts: canonicalQueued.map((message) => runtime.store.getMessageAttachments(message.messageId).length),
    };
    checkpoint('outbox-reopen-drained', outboxFlow);

    const responseLoss = await windowRef.webContents.executeJavaScript(`(async () => {
      const originalFetch = window.fetch;
      let responseDropped = false;
      window.fetch = async (input, init) => {
        const route = typeof input === 'string' ? input : input?.url || '';
        const body = String(init?.body || '');
        if (!responseDropped && route === '/api/messages' && body.includes('Response loss replay.')) {
          const response = await originalFetch(input, init);
          responseDropped = true;
          throw new TypeError('simulated_response_loss');
        }
        return originalFetch(input, init);
      };
      const input = document.querySelector('#messageInput');
      input.value = 'Response loss replay.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      const deadline = Date.now() + 15_000;
      let outboxCount = -1;
      while (Date.now() < deadline) {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open('squidrun-team-room-drafts-v1', 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        outboxCount = await new Promise((resolve, reject) => {
          const request = database.transaction('outbox', 'readonly').objectStore('outbox').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const items = [...document.querySelectorAll('.message-item')].filter((item) => item.innerText.includes('Response loss replay.'));
        if (responseDropped && outboxCount === 0 && items.length === 1 && items[0].innerText.includes('Sent')) {
          window.fetch = originalFetch;
          return { responseDropped, outboxCount, visibleCount: items.length };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      window.fetch = originalFetch;
      return { responseDropped, outboxCount, visibleCount: -1 };
    })()`);
    const responseLossMessages = runtime.store.listMessages().filter((message) => message.body === 'Response loss replay.');
    responseLoss.canonicalCount = responseLossMessages.length;
    responseLoss.activationCount = responseLossMessages.length === 1
      ? runtime.store.listActivations(responseLossMessages[0].messageId).length
      : -1;
    checkpoint('outbox-response-loss-idempotent', responseLoss);

    const failedDrain = await windowRef.webContents.executeJavaScript(`(async () => {
      const originalFetch = window.fetch;
      let firstDrainFailed = false;
      window.fetch = async (input, init) => {
        const route = typeof input === 'string' ? input : input?.url || '';
        const body = String(init?.body || '');
        if (!firstDrainFailed && route === '/api/messages' && body.includes('Failed drain survives.')) {
          firstDrainFailed = true;
          throw new TypeError('simulated_request_failure');
        }
        return originalFetch(input, init);
      };
      const input = document.querySelector('#messageInput');
      input.value = 'Failed drain survives.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const items = [...document.querySelectorAll('.message-item')].filter((item) => item.innerText.includes('Failed drain survives.'));
        if (firstDrainFailed && items.length === 1 && items[0].innerText.includes('Sent')) {
          window.fetch = originalFetch;
          return { firstDrainFailed, visibleCount: items.length };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      window.fetch = originalFetch;
      return { firstDrainFailed, visibleCount: -1 };
    })()`);
    const failedDrainMessages = runtime.store.listMessages().filter((message) => message.body === 'Failed drain survives.');
    failedDrain.canonicalCount = failedDrainMessages.length;
    failedDrain.activationCount = failedDrainMessages.length === 1
      ? runtime.store.listActivations(failedDrainMessages[0].messageId).length
      : -1;
    checkpoint('outbox-failed-drain-retried', failedDrain);

    const credentialsRoot = path.join(smokeRoot, '.squidrun', 'runtime', 'team-room', 'credentials');
    const beforeRespawn = JSON.parse(fs.readFileSync(path.join(credentialsRoot, 'builder.json'), 'utf8'));
    builderLaunchId = `pl_${'9'.repeat(32)}`;
    const respawn = await runtime.start();
    const afterRespawn = JSON.parse(fs.readFileSync(path.join(credentialsRoot, 'builder.json'), 'utf8'));
    const paneRespawn = {
      alreadyRunning: respawn.alreadyRunning,
      rotated: respawn.cliBindingsRotated,
      builderTokenRotated: beforeRespawn.token !== afterRespawn.token,
      webSocketStillConnected: await windowRef.webContents.executeJavaScript(`document.querySelector('#connectionDot').dataset.state === 'connected'`),
    };
    checkpoint('pane-respawn-verified', paneRespawn);

    const visualConversation = [
      {
        role: 'architect',
        body: 'Phase D review is open. Reconnect, recovery, and phone ergonomics are the last line—no shortcuts.',
      },
      {
        role: 'builder',
        body: 'Recovery matrix is green.\n\n- WebSocket catch-up held the scroll anchor\n- Drafts and interrupted uploads restored\n- Install shell activated at desktop and iPhone width',
      },
      {
        role: 'oracle',
        body: 'Immutable packet is next. I’ll rederive the restart, respawn, and attachment boundaries independently.',
      },
    ];
    const visualPrompt = await requestJson(firstStart.origin, '/api/messages', {
      method: 'POST', cookie, origin: firstStart.origin,
      body: {
        body: 'Final visual sweep: give me the state of every lane in one clear pass.',
        clientNonce: 'phase-d-visual-prompt',
      },
    });
    if (visualPrompt.statusCode !== 201) throw new Error(`phase_d_visual_prompt_failed:${visualPrompt.payload.reason}`);
    for (const [index, message] of visualConversation.entries()) {
      const credential = JSON.parse(fs.readFileSync(path.join(credentialsRoot, `${message.role}.json`), 'utf8'));
      const activation = visualPrompt.payload.activations.find((candidate) => candidate.targetMemberId === message.role);
      if (!activation) throw new Error(`phase_d_visual_activation_missing:${message.role}`);
      const activationDeadline = Date.now() + 5_000;
      while (!['claimed', 'delivered'].includes(runtime.store.getActivation(activation.activationId)?.status)
        && Date.now() < activationDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const posted = await requestJson(firstStart.origin, '/api/cli/messages', {
        method: 'POST',
        authorization: `Bearer ${credential.token}`,
        origin: firstStart.origin,
        body: {
          body: message.body,
          clientNonce: `phase-d-visual-${message.role}-${index}`,
          activationId: activation.activationId,
          participationReason: 'direct_answer',
        },
      });
      if (posted.statusCode !== 201) throw new Error(`phase_d_visual_post_failed:${message.role}:${posted.payload.reason}`);
    }
    await waitForRenderer(windowRef, `() => document.querySelector('#messageColumn')?.innerText.includes('Immutable packet is next.')`, 12_000, 'visual-conversation');

    const captureEnabled = Boolean(desktopScreenshotPath || phoneScreenshotPath || keyboardScreenshotPath);
    if (captureEnabled) {
      windowRef.setSkipTaskbar(true);
      windowRef.setOpacity(0);
      windowRef.showInactive();
    }
    windowRef.setContentSize(1180, 820);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      scroll.scrollTop = scroll.scrollHeight;
      document.querySelector('#messageInput').blur();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const desktopCaptureState = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      const visibleRuns = [...document.querySelectorAll('.message-run')].filter((run) => {
        const rect = run.getBoundingClientRect();
        return rect.bottom > scroll.getBoundingClientRect().top && rect.top < scroll.getBoundingClientRect().bottom;
      });
      return { scrollTop: scroll.scrollTop, bottomGap: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop, visibleAuthors: visibleRuns.map((run) => run.dataset.author) };
    })()`);
    if (desktopScreenshotPath) {
      fs.mkdirSync(path.dirname(desktopScreenshotPath), { recursive: true });
      fs.writeFileSync(desktopScreenshotPath, (await windowRef.webContents.capturePage()).toPNG());
    }

    windowRef.webContents.debugger.attach('1.3');
    debuggerAttached = true;
    await windowRef.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await windowRef.webContents.executeJavaScript(`window.dispatchEvent(new Event('resize'))`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const phoneLayout = await windowRef.webContents.executeJavaScript(`(() => {
      const tray = document.querySelector('#uploadTray');
      const counter = document.querySelector('#uploadCount');
      tray.hidden = false;
      counter.hidden = false;
      const renderCards = (count) => {
        counter.textContent = count === 1 ? '1 photo' : \`\${count} photos\`;
        tray.innerHTML = Array.from({ length: count }, (_, index) => \`
        <div class="upload-card" data-status="ready">
          <span class="upload-preview">IMG</span>
          <span class="upload-copy"><strong>mobile-overflow-proof-\${index + 1}.jpeg</strong><span>5.8 MB · Ready</span><span class="upload-progress"><span></span></span></span>
          <button class="upload-action" type="button">×</button>
        </div>\`).join('');
      };
      const layoutCases = Array.from({ length: 10 }, (_, index) => {
        const count = index + 1;
        renderCards(count);
        const caseComposerRect = document.querySelector('#composerForm').getBoundingClientRect();
        const caseSendRect = document.querySelector('#sendButton').getBoundingClientRect();
        const caseCounterRect = counter.getBoundingClientRect();
        return {
          count,
          counterText: counter.textContent,
          counterLeft: Math.round(caseCounterRect.left),
          counterRight: Math.round(caseCounterRect.right),
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
          composerLeft: Math.round(caseComposerRect.left),
          composerRight: Math.round(caseComposerRect.right),
          sendRight: Math.round(caseSendRect.right),
          trayClientWidth: tray.clientWidth,
          trayScrollWidth: tray.scrollWidth,
        };
      });
      const appRect = document.querySelector('#roomApp').getBoundingClientRect();
      const shellRect = document.querySelector('#composerShell').getBoundingClientRect();
      const composerRect = document.querySelector('#composerForm').getBoundingClientRect();
      const sendRect = document.querySelector('#sendButton').getBoundingClientRect();
      const pickerRect = document.querySelector('#fileInput').getBoundingClientRect();
      const pickerButtonRect = document.querySelector('#attachmentButton').getBoundingClientRect();
      const result = {
        width: window.innerWidth,
        height: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        viewportHeightVariable: getComputedStyle(document.documentElement).getPropertyValue('--room-viewport-height').trim(),
        appHeight: Math.round(appRect.height),
        appLeft: Math.round(appRect.left),
        appRight: Math.round(appRect.right),
        memberStackDisplay: getComputedStyle(document.querySelector('.member-stack')).display,
        composerVisible: shellRect.bottom <= window.innerHeight + 1,
        composerLeft: Math.round(composerRect.left),
        composerRight: Math.round(composerRect.right),
        sendRight: Math.round(sendRect.right),
        trayClientWidth: tray.clientWidth,
        trayScrollWidth: tray.scrollWidth,
        uploadCards: tray.querySelectorAll('.upload-card').length,
        counterText: counter.textContent,
        counterVisible: !counter.hidden,
        pickerAnchor: {
          aligned: Math.abs(pickerRect.left - pickerButtonRect.left) <= 1
            && Math.abs(pickerRect.top - pickerButtonRect.top) <= 1
            && Math.abs(pickerRect.width - pickerButtonRect.width) <= 1
            && Math.abs(pickerRect.height - pickerButtonRect.height) <= 1,
          hitTargetId: document.elementFromPoint(
            pickerButtonRect.left + (pickerButtonRect.width / 2),
            pickerButtonRect.top + (pickerButtonRect.height / 2),
          )?.id || null,
          width: Math.round(pickerRect.width),
          height: Math.round(pickerRect.height),
        },
        layoutCases,
      };
      tray.innerHTML = '';
      tray.hidden = true;
      counter.textContent = '';
      counter.hidden = true;
      return result;
    })()`);
    const beforeKeyboardAnchor = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      scroll.scrollTop = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, Math.round(scroll.scrollHeight * .3)));
      const input = document.querySelector('#messageInput');
      input.value = 'Keyboard viewport draft stays put.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      const scrollRect = scroll.getBoundingClientRect();
      const anchor = [...document.querySelectorAll('.message-item[data-message-id]')]
        .find((candidate) => candidate.getBoundingClientRect().bottom >= scrollRect.top + 1);
      return {
        messageId: anchor?.dataset.messageId || null,
        offset: anchor ? anchor.getBoundingClientRect().top - scrollRect.top : 0,
      };
    })()`);
    await windowRef.webContents.executeJavaScript(`(() => {
      const viewport = window.visualViewport;
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => 520 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => 96 });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const afterKeyboardAnchor = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      const scrollRect = scroll.getBoundingClientRect();
      const anchor = [...document.querySelectorAll('.message-item[data-message-id]')]
        .find((candidate) => candidate.getBoundingClientRect().bottom >= scrollRect.top + 1);
      return {
        messageId: anchor?.dataset.messageId || null,
        offset: anchor ? anchor.getBoundingClientRect().top - scrollRect.top : 0,
      };
    })()`);
    await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      scroll.scrollTop = scroll.scrollHeight;
      window.visualViewport.dispatchEvent(new Event('scroll'));
      for (const animation of document.getAnimations()) {
        try { animation.finish(); } catch {}
      }
    })()`);
    const keyboardViewport = await windowRef.webContents.executeJavaScript(`(() => ({
      width: window.innerWidth,
      layoutHeight: window.innerHeight,
      visualHeight: window.visualViewport.height,
      visualOffsetTop: window.visualViewport.offsetTop,
      viewportTopVariable: getComputedStyle(document.documentElement).getPropertyValue('--room-viewport-top').trim(),
      viewportHeightVariable: getComputedStyle(document.documentElement).getPropertyValue('--room-viewport-height').trim(),
      appTop: Math.round(document.querySelector('#roomApp').getBoundingClientRect().top),
      appHeight: Math.round(document.querySelector('#roomApp').getBoundingClientRect().height),
      composerBottom: Math.round(document.querySelector('#composerShell').getBoundingClientRect().bottom),
      composerFormBottom: Math.round(document.querySelector('#composerForm').getBoundingClientRect().bottom),
      inputBottom: Math.round(document.querySelector('#messageInput').getBoundingClientRect().bottom),
      visibleBottom: Math.round(window.visualViewport.offsetTop + window.visualViewport.height),
      keyboardOpen: document.documentElement.dataset.roomKeyboardOpen,
      safeBottomVariable: getComputedStyle(document.documentElement).getPropertyValue('--room-safe-bottom').trim(),
      bottomGap: Math.round(document.querySelector('#messageScroll').scrollHeight
        - document.querySelector('#messageScroll').clientHeight
        - document.querySelector('#messageScroll').scrollTop),
      draft: document.querySelector('#messageInput').value,
      messageRuns: [...document.querySelectorAll('.message-run')].map((run) => {
        const heading = run.querySelector('.run-heading');
        const headingRect = heading.getBoundingClientRect();
        const bodies = [...run.querySelectorAll('.message-body')];
        return {
          author: run.dataset.author,
          name: run.querySelector('.run-name')?.textContent?.trim() || '',
          role: run.querySelector('.run-role')?.textContent?.trim() || '',
          headingVisible: headingRect.bottom > window.visualViewport.offsetTop
            && headingRect.top < window.visualViewport.offsetTop + window.visualViewport.height,
          bodyText: bodies.map((body) => body.innerText).join(' ').trim(),
          bodyVisible: bodies.some((body) => {
            const rect = body.getBoundingClientRect();
            return rect.bottom > window.visualViewport.offsetTop
              && rect.top < window.visualViewport.offsetTop + window.visualViewport.height;
          }),
          bodyColor: bodies[0] ? getComputedStyle(bodies[0]).color : null,
          bodyOpacity: bodies[0] ? getComputedStyle(bodies[0]).opacity : null,
          itemOpacity: bodies[0] ? getComputedStyle(bodies[0].closest('.message-item')).opacity : null,
        };
      }),
    }))()`);
    if (keyboardScreenshotPath) {
      fs.mkdirSync(path.dirname(keyboardScreenshotPath), { recursive: true });
      fs.writeFileSync(keyboardScreenshotPath, (await windowRef.webContents.capturePage({
        x: 0,
        y: keyboardViewport.visualOffsetTop,
        width: keyboardViewport.width,
        height: keyboardViewport.visualHeight,
      })).toPNG());
    }
    await windowRef.webContents.executeJavaScript(`(() => {
      const viewport = window.visualViewport;
      delete viewport.height;
      delete viewport.offsetTop;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      scroll.scrollTop = scroll.scrollHeight;
      document.querySelector('#messageInput').blur();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const phoneCaptureState = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      const visibleRuns = [...document.querySelectorAll('.message-run')].filter((run) => {
        const rect = run.getBoundingClientRect();
        return rect.bottom > scroll.getBoundingClientRect().top && rect.top < scroll.getBoundingClientRect().bottom;
      });
      return { scrollTop: scroll.scrollTop, bottomGap: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop, visibleAuthors: visibleRuns.map((run) => run.dataset.author) };
    })()`);
    if (phoneScreenshotPath) {
      fs.mkdirSync(path.dirname(phoneScreenshotPath), { recursive: true });
      fs.writeFileSync(phoneScreenshotPath, (await windowRef.webContents.capturePage({
        x: 0, y: 0, width: phoneLayout.width, height: phoneLayout.appHeight,
      })).toPNG());
    }
    await windowRef.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 844,
      height: 390,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 844,
      screenHeight: 390,
    });
    await windowRef.webContents.executeJavaScript(`window.dispatchEvent(new Event('resize'))`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const pickerLandscape = await windowRef.webContents.executeJavaScript(`(() => {
      const pickerRect = document.querySelector('#fileInput').getBoundingClientRect();
      const buttonRect = document.querySelector('#attachmentButton').getBoundingClientRect();
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        aligned: Math.abs(pickerRect.left - buttonRect.left) <= 1
          && Math.abs(pickerRect.top - buttonRect.top) <= 1
          && Math.abs(pickerRect.width - buttonRect.width) <= 1
          && Math.abs(pickerRect.height - buttonRect.height) <= 1,
        hitTargetId: document.elementFromPoint(
          buttonRect.left + (buttonRect.width / 2),
          buttonRect.top + (buttonRect.height / 2),
        )?.id || null,
      };
    })()`);
    if (captureEnabled) windowRef.hide();
    checkpoint('visuals-captured');

    const pinchScale = Number(/scale\(([^)]+)\)/u.exec(pinchZoom.transformAfterPinch)?.[1] || 0);
    result = {
      complete: true,
      ok: installShell.manifestLink === '/team-room.webmanifest'
        && installShell.name === 'SquidRun Team Room'
        && installShell.display === 'standalone'
        && installShell.iconChecks.length === 2
        && installShell.iconChecks.every((icon) => icon.ok && icon.type === 'image/png')
        && ['activated', 'not-ready'].includes(installShell.serviceWorker)
        && beforeDrop.bottomGap > 140
        && afterResume.bottomGap > 140
        && afterResume.anchorId === beforeDrop.anchorId
        && Math.abs(afterResume.anchorOffset - beforeDrop.anchorOffset) <= 2
        && /new message/u.test(afterResume.unreadLabel)
        && optimistic.count === 1 && optimistic.pending === false
        && afterServerRestart.connected === 'connected'
        && afterServerRestart.draft === 'Draft survives a full Team Room server restart.'
        && afterServerRestart.catchupPresent
        && interruptedDraftSeeded.length === 2
        && recoveredDraft.readyCards === 2 && recoveredDraft.sendEnabled
        && recoveredDraft.attachmentCount === '2 files' && recoveredDraft.attachmentCountVisible
        && photoCounterFlow.onePhoto === '1 photo'
        && photoCounterFlow.fivePhotos === '5 photos'
        && photoCounterFlow.hiddenAfterRemoval && photoCounterFlow.trayHiddenAfterRemoval
        && singleChooser.directHitTarget === true
        && singleChooser.visibleSourceRect === true
        && singleChooser.alignedToButton === true
        && singleChooser.hiddenAttribute === false
        && singleChooser.customMenuCount === 0
        && singleChooser.captureInputCount === 0
        && singleChooser.multiple === true
        && singleChooser.cancelNoop === true
        && queuedOffline.connected === 'disconnected'
        && queuedOffline.records.length === 3
        && queuedOffline.records.map((record) => record.body).join('|') === 'Offline FIFO first.|Offline FIFO second.|Offline attachment third.'
        && queuedOffline.records[2].attachmentCount === 1
        && queuedOffline.records[2].attachmentBytes > 0
        && queuedOffline.queuedLabels.length === 3
        && queuedOffline.queuedLabels.every((label) => /Queued.*will send when back/u.test(label))
        && queuedOffline.draftCleared
        && outboxFlow.count === 0
        && outboxFlow.connected === 'connected'
        && Object.values(outboxFlow.canonicalCounts).every((count) => count === 1)
        && outboxFlow.seqs.length === 3
        && outboxFlow.seqs.every((seq, index) => index === 0 || seq > outboxFlow.seqs[index - 1])
        && outboxFlow.activationCounts.every((count) => count === 3)
        && outboxFlow.attachmentCounts.join(',') === '0,0,1'
        && responseLoss.responseDropped
        && responseLoss.outboxCount === 0
        && responseLoss.visibleCount === 1
        && responseLoss.canonicalCount === 1
        && responseLoss.activationCount === 3
        && failedDrain.firstDrainFailed
        && failedDrain.visibleCount === 1
        && failedDrain.canonicalCount === 1
        && failedDrain.activationCount === 3
        && attachmentPresentation.imageCaptionOpacity <= .1
        && attachmentPresentation.fileName === 'phase-d-recovery.pdf'
        && attachmentPresentation.fileNameOpacity === 1
        && attachmentPresentation.fileNameVisible
        && pinchScale > 1
        && pinchZoom.transformAfterPan !== pinchZoom.transformAfterPinch
        && pinchZoom.settling === 'true'
        && pinchZoom.transitionDuration === '0.15s'
        && paneRespawn.alreadyRunning === true
        && paneRespawn.rotated?.includes('builder')
        && paneRespawn.builderTokenRotated
        && paneRespawn.webSocketStillConnected
        && phoneLayout.width === 390
        && phoneLayout.documentWidth === phoneLayout.width
        && phoneLayout.bodyWidth === phoneLayout.width
        && phoneLayout.appLeft === 0
        && phoneLayout.appRight === phoneLayout.width
        && phoneLayout.memberStackDisplay === 'none'
        && phoneLayout.appHeight === Number.parseInt(phoneLayout.viewportHeightVariable, 10)
        && phoneLayout.appHeight <= phoneLayout.height
        && phoneLayout.appHeight >= 700
        && phoneLayout.composerVisible
        && phoneLayout.composerLeft >= 0
        && phoneLayout.composerRight <= phoneLayout.width
        && phoneLayout.sendRight <= phoneLayout.width
        && phoneLayout.uploadCards === 10
        && phoneLayout.counterText === '10 photos'
        && phoneLayout.counterVisible
        && phoneLayout.pickerAnchor.aligned === true
        && phoneLayout.pickerAnchor.hitTargetId === 'fileInput'
        && phoneLayout.pickerAnchor.width === 44
        && phoneLayout.pickerAnchor.height === 44
        && pickerLandscape.width === 844
        && pickerLandscape.height === 390
        && pickerLandscape.aligned === true
        && pickerLandscape.hitTargetId === 'fileInput'
        && phoneLayout.trayClientWidth <= phoneLayout.width
        && phoneLayout.trayScrollWidth > phoneLayout.trayClientWidth
        && phoneLayout.layoutCases.length === 10
        && phoneLayout.layoutCases.every((layoutCase) => layoutCase.documentWidth === phoneLayout.width
          && layoutCase.bodyWidth === phoneLayout.width
          && layoutCase.composerLeft >= 0
          && layoutCase.composerRight <= phoneLayout.width
          && layoutCase.sendRight <= phoneLayout.width
          && layoutCase.counterText === (layoutCase.count === 1 ? '1 photo' : `${layoutCase.count} photos`)
          && layoutCase.counterLeft >= 0
          && layoutCase.counterRight <= phoneLayout.width
          && layoutCase.trayClientWidth <= phoneLayout.width)
        && phoneLayout.layoutCases.filter((layoutCase) => layoutCase.count > 1)
          .every((layoutCase) => layoutCase.trayScrollWidth > layoutCase.trayClientWidth)
        && keyboardViewport.width === 390
        && keyboardViewport.layoutHeight === 844
        && keyboardViewport.visualHeight === 520
        && keyboardViewport.visualOffsetTop === 96
        && keyboardViewport.appTop === keyboardViewport.visualOffsetTop
        && keyboardViewport.appHeight === keyboardViewport.visualHeight
        && keyboardViewport.composerBottom === keyboardViewport.visibleBottom
        && keyboardViewport.visibleBottom - keyboardViewport.composerFormBottom <= 10
        && keyboardViewport.visibleBottom - keyboardViewport.inputBottom <= 16
        && keyboardViewport.keyboardOpen === 'true'
        && keyboardViewport.safeBottomVariable === '0px'
        && keyboardViewport.messageRuns
          .filter((run) => run.headingVisible)
          .every((run) => run.bodyText.length > 0
            && run.bodyVisible
            && run.bodyColor === 'rgb(232, 237, 242)'
            && run.bodyOpacity === '1'
            && run.itemOpacity === '1')
        && keyboardViewport.messageRuns
          .filter((run) => ['architect', 'builder', 'oracle'].includes(run.author))
          .every((run) => run.name === ({ architect: 'Mira', builder: 'Rook', oracle: 'Vera' })[run.author]
            && run.role === run.author)
        && keyboardViewport.bottomGap <= 1
        && keyboardViewport.draft === 'Keyboard viewport draft stays put.'
        && afterKeyboardAnchor.messageId === beforeKeyboardAnchor.messageId
        && Math.abs(afterKeyboardAnchor.offset - beforeKeyboardAnchor.offset) <= 2
        && runtime.uploadManager.ownedTemporaryPaths.size === 0
        && consoleErrors.length === 0,
      electron: process.versions.electron,
      node: process.versions.node,
      origin: firstStart.origin,
      installShell,
      beforeDrop,
      afterResume,
      optimistic,
      afterServerRestart,
      interruptedDraftSeeded,
      recoveredDraft,
      singleChooser,
      queuedOffline,
      outboxFlow,
      responseLoss,
      failedDrain,
      attachmentPresentation,
      pinchZoom: { ...pinchZoom, scale: pinchScale },
      paneRespawn,
      visualConversation: {
        posted: visualConversation.map((message) => message.role),
        desktopCaptureState,
        phoneCaptureState,
      },
      phoneLayout,
      pickerLandscape,
      keyboardViewport,
      keyboardScrollAnchor: { before: beforeKeyboardAnchor, after: afterKeyboardAnchor },
      temporaryPathCount: runtime.uploadManager.ownedTemporaryPaths.size,
      consoleErrors,
      screenshots: {
        desktop: desktopScreenshotPath || null,
        phone: phoneScreenshotPath || null,
      },
      smokeRoot,
    };
    checkpoint('result-computed', { ok: result.ok });
  } finally {
    checkpoint('cleanup-started');
    try {
      await windowRef?.webContents.executeJavaScript(`navigator.serviceWorker?.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))`);
    } catch {}
    checkpoint('service-worker-unregistered');
    try { if (debuggerAttached) windowRef?.webContents.debugger.detach(); } catch {}
    debuggerAttached = false;
    checkpoint('debugger-detached');
    try { await runtime.stop(); } catch {}
    checkpoint('runtime-stopped');
    try { await windowRef?.webContents.session.clearStorageData(); } catch {}
    checkpoint('storage-cleared');
    try { windowRef?.destroy(); } catch {}
    checkpoint('window-destroyed');
    try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
    checkpoint('smoke-root-cleaned');
    if (result) result.smokeRootRemoved = !fs.existsSync(smokeRoot);
  }

  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (!result?.ok) {
    const error = new Error('team_room_phase_d_browser_smoke_failed');
    error.result = result;
    throw error;
  }
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    try {
      fs.writeFileSync(outputPath, `${JSON.stringify({
        ...(error.result || {}),
        complete: true,
        ok: false,
        error: error.stack || error.message,
        smokeRoot,
      }, null, 2)}\n`, 'utf8');
    } catch {}
    app.exit(1);
  });
