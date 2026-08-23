'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { TeamRoomRuntime } = require('../../modules/main/team-room-runtime');
const { createTeamRoomWindow } = require('../../modules/main/team-room-window');

const outputPath = path.resolve(String(process.env.TEAM_ROOM_WINDOW_PERFORMANCE_OUTPUT || ''));
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-window-performance-'));
app.setPath('userData', path.join(smokeRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});

function electronProcessIds() {
  try {
    return [...new Set([
      process.pid,
      ...app.getAppMetrics()
        .map((metric) => Number(metric.pid))
        .filter(Number.isInteger),
    ])];
  } catch {
    return [process.pid];
  }
}

function bindings(appGeneration) {
  return {
    ok: true,
    bindings: Object.fromEntries(['architect', 'builder', 'oracle'].map((role, index) => [role, {
      role,
      paneId: String(index + 1),
      profileName: 'main',
      paneLaunchId: `pl_${String(index + 1).repeat(32)}`,
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
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ statusCode: response.statusCode, payload });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function waitForRenderer(windowRef, predicate, timeoutMs = 15_000) {
  return windowRef.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + ${Number(timeoutMs)};
    while (Date.now() < deadline) {
      const value = (${predicate})();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('team_room_window_performance_renderer_timeout');
  })()`);
}

function runtimeOptions() {
  return {
    appGeneration: `app-session-${String(process.pid)}`,
    projectRoot: smokeRoot,
    publicRoot: path.resolve(__dirname, '..', '..'),
    runtimeRoot: path.join(smokeRoot, '.squidrun', 'runtime', 'team-room'),
    host: '127.0.0.1',
    port: 0,
    lanEnabled: false,
    allowedOrigins: [],
    storeOptions: {
      dbPath: path.join(smokeRoot, 'room', 'room.db'),
      attachmentRoot: path.join(smokeRoot, 'room', 'attachments'),
    },
    deliverToPane: async () => ({ ok: true }),
    resolveCliBindings: ({ appGeneration }) => bindings(appGeneration),
  };
}

async function seedMessages(origin, cookie, count) {
  const batchSize = 35;
  for (let start = 1; start <= count; start += batchSize) {
    const indexes = Array.from(
      { length: Math.min(batchSize, count - start + 1) },
      (_unused, offset) => start + offset
    );
    const results = await Promise.all(indexes.map((index) => requestJson(origin, '/api/messages', {
      method: 'POST',
      cookie,
      origin,
      body: {
        body: `Performance history message ${index}. Preserve this reading position while the window changes.`,
        clientNonce: `window-performance-seed-${index}`,
      },
    })));
    const failed = results.find((result) => result.statusCode !== 201);
    if (failed) throw new Error(`team_room_window_performance_seed_failed:${failed.statusCode}`);
  }
}

async function resizeProbe(windowRef, width, height) {
  if (width <= 640) {
    if (!windowRef.webContents.debugger.isAttached()) windowRef.webContents.debugger.attach('1.3');
    await windowRef.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: width,
      screenHeight: height,
    });
  } else {
    windowRef.setContentSize(width, height);
  }
  await new Promise((resolve) => setTimeout(resolve, 260));
  return windowRef.webContents.executeJavaScript(`(async () => {
    const scroll = document.querySelector('#messageScroll');
    scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight - 48);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const scrollRect = scroll.getBoundingClientRect();
    const anchor = [...document.querySelectorAll('.message-item')]
      .find((item) => item.getBoundingClientRect().bottom >= scrollRect.top + 1);
    const before = {
      messageId: anchor?.dataset.messageId || null,
      offset: anchor ? anchor.getBoundingClientRect().top - scrollRect.top : null,
    };
    const originalRect = Element.prototype.getBoundingClientRect;
    let messageRectReads = 0;
    Element.prototype.getBoundingClientRect = function countedRect() {
      if (this.matches?.('.message-item')) messageRectReads += 1;
      return originalRect.call(this);
    };
    try {
      for (let index = 0; index < 30; index += 1) {
        window.dispatchEvent(new Event('resize'));
        window.visualViewport?.dispatchEvent(new Event('resize'));
      }
      await new Promise((resolve) => setTimeout(resolve, 220));
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
    }
    const afterScrollRect = scroll.getBoundingClientRect();
    const afterAnchor = before.messageId
      ? document.querySelector('.message-item[data-message-id="' + before.messageId + '"]')
      : null;
    return {
      width: window.innerWidth,
      messageCount: document.querySelectorAll('.message-item').length,
      messageRectReads,
      before,
      after: {
        messageId: afterAnchor?.dataset.messageId || null,
        offset: afterAnchor ? afterAnchor.getBoundingClientRect().top - afterScrollRect.top : null,
      },
      bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      latestHidden: document.querySelector('#unreadMarker').hidden,
      latestLabel: document.querySelector('#unreadMarkerLabel').textContent,
      resizing: document.documentElement.dataset.roomResizing || null,
    };
  })()`);
}

async function run() {
  if (!outputPath) throw new Error('TEAM_ROOM_WINDOW_PERFORMANCE_OUTPUT_required');
  const runtime = new TeamRoomRuntime(runtimeOptions());
  let windowRef = null;
  let result = null;
  const consoleErrors = [];
  try {
    const started = await runtime.start();
    if (!started.ok) throw new Error(started.reason);
    const paired = runtime._issueCredential('james', 'room_web', 'paired_device', {
      ttlMs: 24 * 60 * 60 * 1000,
    });
    if (!paired.ok) throw new Error(paired.reason);
    const cookie = `squidrun_team_room=${paired.token}`;
    await seedMessages(started.origin, cookie, 875);

    const created = await createTeamRoomWindow({
      BrowserWindow,
      origin: started.origin,
      credentialToken: paired.token,
      statePath: path.join(smokeRoot, 'window-state.json'),
      showOnReady: false,
      windowOptions: {
        width: 1100,
        height: 760,
        minWidth: 320,
        minHeight: 480,
        x: -10_000,
        y: -10_000,
        skipTaskbar: true,
      },
    });
    windowRef = created.window;
    windowRef.webContents.on('console-message', (_event, level, message) => {
      if (Number(level) >= 2) consoleErrors.push(String(message));
    });
    windowRef.setOpacity(0);
    windowRef.showInactive();
    await waitForRenderer(windowRef, `() => document.querySelector('#connectionDot')?.dataset.state === 'connected'
      && document.querySelectorAll('.message-item').length === 875`);

    const desktopResize = await resizeProbe(windowRef, 1100, 760);
    const phoneResize = await resizeProbe(windowRef, 390, 760);

    await windowRef.webContents.executeJavaScript(`document.querySelector('#unreadMarker').click()`);
    await waitForRenderer(windowRef, `() => document.querySelector('#unreadMarker')?.hidden
      && document.querySelector('#messageScroll').scrollHeight
        - document.querySelector('#messageScroll').scrollTop
        - document.querySelector('#messageScroll').clientHeight <= 3`);
    const latestJump = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      return {
        bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        hidden: document.querySelector('#unreadMarker').hidden,
      };
    })()`);

    runtime._broadcast({
      type: 'message',
      message: {
        messageId: 'trm_window_performance_following_reply',
        seq: 876,
        authorId: 'oracle',
        author: { memberId: 'oracle', displayName: 'Vera', memberKind: 'agent', role: 'oracle' },
        body: 'This long reply should keep following while the reader leaves it alone. '.repeat(16),
        attachments: [],
        createdAtMs: Date.now(),
      },
    });
    await waitForRenderer(windowRef, `() => document.querySelector('[data-message-id="trm_window_performance_following_reply"]')?.dataset.typewriterActive === 'true'`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const untouchedTypewriter = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      return { bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight };
    })()`);

    runtime._broadcast({
      type: 'message',
      message: {
        messageId: 'trm_window_performance_skipped_reply',
        seq: 877,
        authorId: 'architect',
        author: { memberId: 'architect', displayName: 'Mira', memberKind: 'agent', role: 'architect' },
        body: 'Tapping this reply to reveal it immediately should still keep an untouched bottom reader at the bottom. '.repeat(16),
        attachments: [],
        createdAtMs: Date.now() + 1,
      },
    });
    await waitForRenderer(windowRef, `() => document.querySelector('[data-message-id="trm_window_performance_skipped_reply"]')?.dataset.typewriterActive === 'true'`);
    const skippedTypewriter = await windowRef.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-message-id="trm_window_performance_skipped_reply"] .message-body').click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const scroll = document.querySelector('#messageScroll');
      return {
        active: document.querySelector('[data-message-id="trm_window_performance_skipped_reply"]')?.dataset.typewriterActive || null,
        bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      };
    })()`);

    runtime._broadcast({
      type: 'message',
      message: {
        messageId: 'trm_window_performance_interrupted_reply',
        seq: 878,
        authorId: 'builder',
        author: { memberId: 'builder', displayName: 'Rook', memberKind: 'agent', role: 'builder' },
        body: 'This long reply must stop following as soon as the reader wheels or touches the history. '.repeat(16),
        attachments: [],
        createdAtMs: Date.now() + 2,
      },
    });
    await waitForRenderer(windowRef, `() => document.querySelector('[data-message-id="trm_window_performance_interrupted_reply"]')?.dataset.typewriterActive === 'true'`);
    const interruptedTypewriter = await windowRef.webContents.executeJavaScript(`(async () => {
      const scroll = document.querySelector('#messageScroll');
      scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
      scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight - 48);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        latestHidden: document.querySelector('#unreadMarker').hidden,
        latestLabel: document.querySelector('#unreadMarkerLabel').textContent,
      };
    })()`);

    const incomingBefore = await windowRef.webContents.executeJavaScript(`(async () => {
      const scroll = document.querySelector('#messageScroll');
      scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight - 48);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const scrollRect = scroll.getBoundingClientRect();
      const anchor = [...document.querySelectorAll('.message-item')]
        .find((item) => item.getBoundingClientRect().bottom >= scrollRect.top + 1);
      return {
        messageId: anchor?.dataset.messageId || null,
        offset: anchor ? anchor.getBoundingClientRect().top - scrollRect.top : null,
        bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      };
    })()`);
    runtime._broadcast({
      type: 'message',
      message: {
        messageId: 'trm_window_performance_agent_reply',
        seq: 879,
        authorId: 'oracle',
        author: { memberId: 'oracle', displayName: 'Vera', memberKind: 'agent', role: 'oracle' },
        body: 'This incoming typed reply must never pull the reader away from the history they chose to read. '.repeat(8),
        attachments: [],
        createdAtMs: Date.now(),
      },
    });
    await waitForRenderer(windowRef, `() => document.querySelector('[data-message-id="trm_window_performance_agent_reply"]')
      && !document.querySelector('#unreadMarker')?.hidden`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const incomingAfter = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      const scrollRect = scroll.getBoundingClientRect();
      const anchor = document.querySelector('.message-item[data-message-id="${incomingBefore.messageId}"]');
      return {
        messageId: anchor?.dataset.messageId || null,
        offset: anchor ? anchor.getBoundingClientRect().top - scrollRect.top : null,
        bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        latestLabel: document.querySelector('#unreadMarkerLabel').textContent,
      };
    })()`);

    windowRef.webContents.reload();
    await waitForRenderer(windowRef, `() => document.querySelector('#connectionDot')?.dataset.state === 'connected'
      && document.querySelectorAll('.message-item').length === 875`);

    const localBody = 'My local send must land at the newest message.';
    await windowRef.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#messageInput');
      input.value = ${JSON.stringify(localBody)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendButton').click();
    })()`);
    await waitForRenderer(windowRef, `() => {
      const scroll = document.querySelector('#messageScroll');
      const matches = [...document.querySelectorAll('.message-item')]
        .filter((item) => item.innerText.includes(${JSON.stringify(localBody)}));
      return matches.length === 1
        && !matches[0].dataset.pending
        && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 3;
    }`);
    const localSend = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      return { bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight };
    })()`);

    const canonical = runtime.store.listMessages().find((message) => message.body === localBody);
    if (!canonical) throw new Error('team_room_window_performance_local_message_missing');
    const duplicateBefore = await windowRef.webContents.executeJavaScript(`(async () => {
      const scroll = document.querySelector('#messageScroll');
      scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight - 48);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const scrollRect = scroll.getBoundingClientRect();
      const anchor = [...document.querySelectorAll('.message-item')]
        .find((item) => item.getBoundingClientRect().bottom >= scrollRect.top + 1);
      return {
        messageId: anchor?.dataset.messageId || null,
        offset: anchor ? anchor.getBoundingClientRect().top - scrollRect.top : null,
        bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      };
    })()`);
    const duplicate = await requestJson(started.origin, '/api/messages', {
      method: 'POST',
      cookie,
      origin: started.origin,
      body: { body: canonical.body, clientNonce: canonical.clientNonce },
    });
    if (duplicate.statusCode !== 200) throw new Error(`team_room_window_performance_duplicate_failed:${duplicate.statusCode}`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const duplicateAfter = await windowRef.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('#messageScroll');
      const scrollRect = scroll.getBoundingClientRect();
      const anchor = document.querySelector('.message-item[data-message-id="${duplicateBefore.messageId}"]');
      return {
        messageId: anchor?.dataset.messageId || null,
        offset: anchor ? anchor.getBoundingClientRect().top - scrollRect.top : null,
        bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        latestLabel: document.querySelector('#unreadMarkerLabel').textContent,
      };
    })()`);

    const anchorStable = (before, after) => before.messageId === after.messageId
      && Math.abs(Number(before.offset) - Number(after.offset)) <= 2;
    result = {
      complete: true,
      ok: desktopResize.messageCount === 875
        && desktopResize.width === 1100
        && desktopResize.messageRectReads <= 20
        && desktopResize.bottomGap > 3
        && desktopResize.latestHidden === false
        && desktopResize.latestLabel === 'Latest'
        && desktopResize.resizing === null
        && anchorStable(desktopResize.before, desktopResize.after)
        && phoneResize.messageCount === 875
        && phoneResize.width === 390
        && phoneResize.messageRectReads <= 20
        && phoneResize.bottomGap > 3
        && phoneResize.latestHidden === false
        && phoneResize.latestLabel === 'Latest'
        && phoneResize.resizing === null
        && anchorStable(phoneResize.before, phoneResize.after)
        && latestJump.bottomGap <= 3
        && latestJump.hidden === true
        && untouchedTypewriter.bottomGap <= 3
        && skippedTypewriter.active === null
        && skippedTypewriter.bottomGap <= 3
        && interruptedTypewriter.bottomGap > 3
        && interruptedTypewriter.latestHidden === false
        && interruptedTypewriter.latestLabel === 'Latest'
        && anchorStable(incomingBefore, incomingAfter)
        && incomingAfter.bottomGap > 3
        && incomingAfter.latestLabel === '1 new message'
        && localSend.bottomGap <= 3
        && duplicateBefore.bottomGap > 3
        && anchorStable(duplicateBefore, duplicateAfter)
        && duplicateAfter.bottomGap > 3
        && duplicateAfter.latestLabel === 'Latest'
        && consoleErrors.length === 0,
      electron: process.versions.electron,
      node: process.versions.node,
      desktopResize,
      phoneResize,
      latestJump,
      typewriter: {
        untouched: untouchedTypewriter,
        skipped: skippedTypewriter,
        interrupted: interruptedTypewriter,
      },
      incoming: { before: incomingBefore, after: incomingAfter },
      localSend,
      duplicate: { statusCode: duplicate.statusCode, before: duplicateBefore, after: duplicateAfter },
      consoleErrors,
      mainPid: process.pid,
      smokeRoot,
    };
  } catch (error) {
    result = {
      complete: true,
      ok: false,
      reason: error?.stack || String(error),
      consoleErrors,
      mainPid: process.pid,
      smokeRoot,
    };
  } finally {
    const processPids = electronProcessIds();
    try { await runtime.stop(); } catch {}
    try { if (windowRef?.webContents.debugger.isAttached()) windowRef.webContents.debugger.detach(); } catch {}
    try { windowRef?.destroy(); } catch {}
    try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
    if (result) {
      result.smokeRootRemoved = !fs.existsSync(smokeRoot);
      result.processPids = processPids;
    }
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (!result?.ok) throw Object.assign(new Error('team_room_window_performance_failed'), { result });
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
        reason: error.stack || error.message,
        mainPid: process.pid,
        processPids: electronProcessIds(),
        smokeRoot,
      }, null, 2)}\n`, 'utf8');
    } catch {}
    app.exit(1);
  });
