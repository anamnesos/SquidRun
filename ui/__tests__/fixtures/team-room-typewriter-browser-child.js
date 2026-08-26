'use strict';

const Module = require('node:module');
Module._initPaths();
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const outputPath = path.resolve(String(process.env.TEAM_ROOM_TYPEWRITER_OUTPUT || ''));
const pidPath = String(process.env.TEAM_ROOM_TYPEWRITER_PID || '').trim();
if (pidPath) fs.writeFileSync(path.resolve(pidPath), `${process.pid}\n`, 'utf8');
const { TeamRoomRuntime } = require('../../modules/main/team-room-runtime');
const { createTeamRoomWindow } = require('../../modules/main/team-room-window');
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-typewriter-browser-'));
app.setPath('userData', path.join(smokeRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');
if (process.env.TEAM_ROOM_TEST_FORCE_REDUCED_MOTION === '1') {
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
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
        resolve({ statusCode: response.statusCode, payload });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function waitForRenderer(windowRef, predicate, timeoutMs = 8_000, label = 'unnamed') {
  return windowRef.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + ${Number(timeoutMs)};
    while (Date.now() < deadline) {
      const value = (${predicate})();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('team_room_typewriter_wait_timeout:${String(label)}');
  })()`);
}

async function waitForActivation(runtime, activationId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const activation = runtime.store.getActivation(activationId);
    if (['claimed', 'delivered'].includes(activation?.status)) return activation;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`team_room_typewriter_activation_timeout:${activationId}`);
}

async function run() {
  if (!process.env.TEAM_ROOM_TYPEWRITER_OUTPUT) throw new Error('TEAM_ROOM_TYPEWRITER_OUTPUT_required');
  const runtimeRoot = path.join(smokeRoot, '.squidrun', 'runtime', 'team-room');
  const runtime = new TeamRoomRuntime({
    appGeneration: `app-session-${Math.max(1, process.pid)}`,
    projectRoot: smokeRoot,
    publicRoot: path.resolve(__dirname, '..', '..'),
    runtimeRoot,
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
  });
  let windowRef = null;
  let debuggerAttached = false;
  let result = null;
  const consoleErrors = [];

  try {
    const started = await runtime.start();
    if (!started.ok) throw new Error(started.reason);
    const credential = runtime._issueCredential('operator', 'room_web', 'paired_device', {
      ttlMs: 60 * 60 * 1000,
    });
    if (!credential.ok) throw new Error(credential.reason);
    const cookie = `squidrun_team_room=${credential.token}`;
    const credentialsRoot = path.join(runtimeRoot, 'credentials');

    const postOperator = async (body, clientNonce) => {
      const posted = await requestJson(started.origin, '/api/messages', {
        method: 'POST',
        cookie,
        origin: started.origin,
        body: { body, clientNonce },
      });
      if (posted.statusCode !== 201) throw new Error(`typewriter_operator_post_failed:${posted.payload.reason}`);
      return posted.payload;
    };
    const replyAs = async (role, rootPayload, body, clientNonce) => {
      const activation = rootPayload.activations.find((candidate) => candidate.targetMemberId === role);
      if (!activation) throw new Error(`typewriter_activation_missing:${role}`);
      await waitForActivation(runtime, activation.activationId);
      const roleCredential = JSON.parse(fs.readFileSync(path.join(credentialsRoot, `${role}.json`), 'utf8'));
      const posted = await requestJson(started.origin, '/api/cli/messages', {
        method: 'POST',
        authorization: `Bearer ${roleCredential.token}`,
        origin: started.origin,
        body: {
          body,
          clientNonce,
          activationId: activation.activationId,
          participationReason: 'direct_answer',
        },
      });
      if (posted.statusCode !== 201) throw new Error(`typewriter_agent_post_failed:${role}:${posted.payload.reason}`);
      return posted.payload;
    };

    const historyBody = 'This agent reply existed before the window opened, so history must render in full immediately.';
    const historyRoot = await postOperator('Seed one historical agent reply.', 'typewriter-history-root');
    const historyReply = await replyAs('architect', historyRoot, historyBody, 'typewriter-history-agent');

    const electronCredential = runtime.issueElectronCredential();
    if (!electronCredential.ok) throw new Error(electronCredential.reason);
    const created = await createTeamRoomWindow({
      BrowserWindow,
      origin: started.origin,
      credentialToken: electronCredential.token,
      statePath: path.join(smokeRoot, 'window-state.json'),
      showOnReady: false,
      windowOptions: { width: 900, height: 720, minWidth: 320, minHeight: 480 },
    });
    windowRef = created.window;
    windowRef.webContents.debugger.attach('1.3');
    debuggerAttached = true;
    await windowRef.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    windowRef.webContents.on('console-message', (_event, level, message) => {
      if (Number(level) >= 2) consoleErrors.push(String(message));
    });
    await waitForRenderer(windowRef, `() => document.querySelector('#connectionDot')?.dataset.state === 'connected'
      && !matchMedia('(prefers-reduced-motion: reduce)').matches
      && document.querySelector('.message-item[data-message-id="${historyReply.message.messageId}"]')?.innerText.includes(${JSON.stringify(historyBody)})`, 12_000, 'initial-history');
    const history = await windowRef.webContents.executeJavaScript(`(() => {
      const item = document.querySelector('.message-item[data-message-id="${historyReply.message.messageId}"]');
      return {
        full: item?.querySelector('.message-body')?.innerText === ${JSON.stringify(historyBody)},
        active: item?.dataset.typewriterActive === 'true',
        activeCount: document.querySelectorAll('.message-item[data-typewriter-active="true"]').length,
      };
    })()`);

    const operatorBody = 'Operator messages render instantly, even while the socket is live.';
    const operatorLive = await postOperator(operatorBody, 'typewriter-live-operator');
    await waitForRenderer(windowRef, `() => Boolean(document.querySelector('.message-item[data-message-id="${operatorLive.message.messageId}"]'))`, 8_000, 'live-operator');
    const operator = await windowRef.webContents.executeJavaScript(`(() => {
      const item = document.querySelector('.message-item[data-message-id="${operatorLive.message.messageId}"]');
      return {
        full: item?.querySelector('.message-body')?.innerText === ${JSON.stringify(operatorBody)},
        active: item?.dataset.typewriterActive === 'true',
      };
    })()`);

    const skipBody = 'This is a deliberately long agent answer so the typewriter remains visible long enough to prove that tapping the bubble reveals the complete saved message immediately. '.repeat(5).trim();
    const skipReply = await replyAs('builder', operatorLive, skipBody, 'typewriter-live-builder');
    const partial = await waitForRenderer(windowRef, `() => {
      const item = document.querySelector('.message-item[data-message-id="${skipReply.message.messageId}"]');
      const text = item?.querySelector('.message-body')?.innerText || '';
      return item?.dataset.typewriterActive === 'true' && text.length > 0 && text.length < ${JSON.stringify(skipBody)}.length
        ? { active: true, textLength: text.length }
        : null;
    }`, 8_000, 'agent-partial');
    await windowRef.webContents.executeJavaScript(`document.querySelector('.message-item[data-message-id="${skipReply.message.messageId}"] .message-body').click()`);
    const skipped = await waitForRenderer(windowRef, `() => {
      const item = document.querySelector('.message-item[data-message-id="${skipReply.message.messageId}"]');
      return item?.dataset.typewriterActive !== 'true'
        && item?.querySelector('.message-body')?.innerText === ${JSON.stringify(skipBody)};
    }`, 2_000, 'agent-skip');

    await windowRef.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await waitForRenderer(windowRef, `() => matchMedia('(prefers-reduced-motion: reduce)').matches`, 2_000, 'reduce-motion-on');
    const reducedRoot = await postOperator('Reply while Reduce Motion is enabled.', 'typewriter-reduced-root');
    const reducedBody = 'Reduce Motion makes this full agent reply appear immediately without a caret or partial text.';
    const reducedReply = await replyAs('oracle', reducedRoot, reducedBody, 'typewriter-reduced-oracle');
    const reduced = await waitForRenderer(windowRef, `() => {
      const item = document.querySelector('.message-item[data-message-id="${reducedReply.message.messageId}"]');
      if (!item) return null;
      const body = item.querySelector('.message-body')?.innerText || '';
      return body === ${JSON.stringify(reducedBody)} ? {
        mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        active: item.dataset.typewriterActive === 'true',
        full: true,
      } : null;
    }`, 8_000, 'reduced-motion-agent');

    await windowRef.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    await waitForRenderer(windowRef, `() => !matchMedia('(prefers-reduced-motion: reduce)').matches`, 2_000, 'reduce-motion-off');
    const boundedRoot = await postOperator('Give me the long answer at normal motion.', 'typewriter-bounded-root');
    const boundedBody = `Long answer: ${'the cadence accelerates instead of making Operator wait. '.repeat(80)}`.trim();
    const boundedStartedAt = Date.now();
    const boundedReply = await replyAs('architect', boundedRoot, boundedBody, 'typewriter-bounded-architect');
    const boundedPartial = await waitForRenderer(windowRef, `() => {
      const item = document.querySelector('.message-item[data-message-id="${boundedReply.message.messageId}"]');
      const text = item?.querySelector('.message-body')?.innerText || '';
      return item?.dataset.typewriterActive === 'true' && text.length > 0 && text.length < ${JSON.stringify(boundedBody)}.length;
    }`, 8_000, 'bounded-partial');
    await waitForRenderer(windowRef, `() => {
      const item = document.querySelector('.message-item[data-message-id="${boundedReply.message.messageId}"]');
      return item?.dataset.typewriterActive !== 'true'
        && item?.querySelector('.message-body')?.innerText === ${JSON.stringify(boundedBody)};
    }`, 4_000, 'bounded-complete');
    const bounded = {
      partial: boundedPartial === true,
      elapsedMs: Date.now() - boundedStartedAt,
    };

    result = {
      complete: true,
      ok: history.full
        && !history.active
        && history.activeCount === 0
        && operator.full
        && !operator.active
        && partial.active
        && partial.textLength < skipBody.length
        && skipped === true
        && reduced.mediaMatches
        && reduced.full
        && !reduced.active
        && bounded.partial
        && bounded.elapsedMs < 2_800
        && consoleErrors.length === 0,
      electron: process.versions.electron,
      node: process.versions.node,
      history,
      operator,
      partial,
      skipped,
      reduced,
      bounded,
      consoleErrors,
      smokeRoot,
    };
  } finally {
    if (debuggerAttached) {
      try { windowRef?.webContents.debugger.detach(); } catch {}
    }
    try { windowRef?.destroy(); } catch {}
    for (const client of runtime.clients) {
      try { client.terminate(); } catch {}
    }
    try { runtime.server?.closeAllConnections?.(); } catch {}
    try {
      await Promise.race([runtime.stop(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    } catch {}
    try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
    if (result) result.smokeRootRemoved = !fs.existsSync(smokeRoot);
  }

  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (!result?.ok) throw new Error('team_room_typewriter_browser_smoke_failed');
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    try {
      fs.writeFileSync(outputPath, `${JSON.stringify({
        complete: true,
        ok: false,
        error: error.stack || error.message,
        smokeRoot,
      }, null, 2)}\n`, 'utf8');
    } catch {}
    app.exit(1);
  });
