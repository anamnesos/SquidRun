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
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-phase-d-browser-'));
app.setPath('userData', path.join(smokeRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');

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
        const request = indexedDB.open('squidrun-team-room-drafts-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('attachments', { keyPath: 'localId' });
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
      draft: document.querySelector('#messageInput').value,
      sendEnabled: !document.querySelector('#sendButton').disabled,
    }))()`);
    checkpoint('interrupted-draft-restored', recoveredDraft);
    await windowRef.webContents.executeJavaScript(`document.querySelector('#sendButton').click()`);
    await waitForRenderer(windowRef, `() => document.querySelectorAll('.message-attachments .media-tile').length >= 1
      && document.querySelectorAll('.message-attachments .file-tile').length >= 1
      && document.querySelector('#uploadTray')?.hidden`, 15_000, 'attachment-send');
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

    const captureEnabled = Boolean(desktopScreenshotPath || phoneScreenshotPath);
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
    const phoneLayout = await windowRef.webContents.executeJavaScript(`(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      viewportHeightVariable: getComputedStyle(document.documentElement).getPropertyValue('--room-viewport-height').trim(),
      appHeight: Math.round(document.querySelector('#roomApp').getBoundingClientRect().height),
      memberStackDisplay: getComputedStyle(document.querySelector('.member-stack')).display,
      composerVisible: document.querySelector('#composerShell').getBoundingClientRect().bottom <= window.innerHeight + 1,
    }))()`);
    await windowRef.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 520,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await windowRef.webContents.executeJavaScript(`window.dispatchEvent(new Event('resize'))`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await windowRef.webContents.executeJavaScript(`document.querySelector('#messageInput').focus()`);
    const keyboardViewport = await windowRef.webContents.executeJavaScript(`(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      viewportHeightVariable: getComputedStyle(document.documentElement).getPropertyValue('--room-viewport-height').trim(),
      appHeight: Math.round(document.querySelector('#roomApp').getBoundingClientRect().height),
      composerBottom: Math.round(document.querySelector('#composerShell').getBoundingClientRect().bottom),
    }))()`);
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
        && phoneLayout.memberStackDisplay === 'none'
        && phoneLayout.appHeight === Number.parseInt(phoneLayout.viewportHeightVariable, 10)
        && phoneLayout.appHeight <= phoneLayout.height
        && phoneLayout.appHeight >= 700
        && phoneLayout.composerVisible
        && keyboardViewport.width === 390
        && keyboardViewport.appHeight === keyboardViewport.height
        && keyboardViewport.composerBottom <= keyboardViewport.height + 1
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
      attachmentPresentation,
      pinchZoom: { ...pinchZoom, scale: pinchScale },
      paneRespawn,
      visualConversation: {
        posted: visualConversation.map((message) => message.role),
        desktopCaptureState,
        phoneCaptureState,
      },
      phoneLayout,
      keyboardViewport,
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
