'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { DaemonClient } = require('../daemon-client');
const { getProfilePipePath } = require('../profile');
const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const {
  closeArmSpawnJournalStores,
  queryArmSpawnSessions,
  recordArmSpawnLifecycle,
} = require('../modules/main/arm-spawn-journal');
const { closeCommsJournalStores } = require('../modules/main/comms-journal');
const { probeArmLiveness } = require('../modules/main/arm-liveness-probe');
const {
  buildArmDurableAddress,
  spawnArmWithAtomicSession,
} = require('../modules/main/arm-spawn-transaction');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await Promise.resolve(predicate());
    if (value) return value;
    await delay(intervalMs);
  }
  return null;
}

async function waitForExit(child, timeoutMs = 3_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ exited: false, code: null, signal: null }), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ exited: true, code, signal });
    });
  });
}

async function connectClient(client) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await client._tryConnect()) return true;
    await delay(50);
  }
  return false;
}

function quotePaneCommand(nodePath, fixturePath) {
  if (process.platform === 'win32') {
    return `& "${nodePath.replace(/"/g, '`"')}" "${fixturePath.replace(/"/g, '`"')}"`;
  }
  const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  return `${shellQuote(nodePath)} ${shellQuote(fixturePath)}`;
}

function killProcessTree(pid) {
  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  process.kill(pid, 'SIGKILL');
}

async function startQaCommsBroker({ dbPath, paneId, profileName }) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (socket) => {
    const state = { role: null, sessionScopeId: null };
    socket.send(JSON.stringify({ type: 'welcome', profileName }));
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === 'register') {
        state.role = message.role || null;
        state.sessionScopeId = message.sessionScopeId || null;
        socket.send(JSON.stringify({
          type: 'registered',
          role: state.role,
          profileName,
          windowKey: profileName,
          sessionScopeId: state.sessionScopeId,
        }));
        return;
      }
      if (message.type === 'health-check') {
        socket.send(JSON.stringify({
          type: 'health-check-result',
          requestId: message.requestId || null,
          target: message.target || null,
          healthy: true,
          status: 'healthy',
          timestamp: Date.now(),
        }));
        return;
      }
      if (message.type === 'delivery-check') {
        socket.send(JSON.stringify({
          type: 'delivery-check-result',
          requestId: message.requestId || null,
          messageId: message.messageId || null,
          status: 'delivered.verified',
          delivered: true,
          timestamp: Date.now(),
        }));
        return;
      }
      if (message.type !== 'send') return;

      const nowMs = Date.now();
      const metadata = message.metadata && typeof message.metadata === 'object'
        ? message.metadata
        : {};
      const senderRole = state.role || metadata.sender?.role || 'unknown';
      const store = new EvidenceLedgerStore({ dbPath, enabled: true });
      const init = store.init();
      const journal = init.ok
        ? store.upsertCommsJournal({
            messageId: message.messageId,
            sessionId: metadata.session_id || state.sessionScopeId || null,
            senderRole,
            targetRole: message.target || 'architect',
            channel: 'ws',
            direction: 'outbound',
            sentAtMs: metadata.timestamp_ms || nowMs,
            brokeredAtMs: nowMs,
            rawBody: message.content,
            status: 'routed',
            ackStatus: 'delivered.verified',
            attempt: message.attempt || 1,
            metadata: {
              ...metadata,
              source: 'build-1a-test-copy-qa-broker',
              sender: {
                ...(metadata.sender && typeof metadata.sender === 'object' ? metadata.sender : {}),
                role: senderRole,
                pane_id: paneId,
              },
              qaInstance: {
                class: 'throwaway',
                title: 'Build 1A TEST COPY',
              },
            },
          }, { nowMs })
        : { ok: false, reason: init.reason || 'store_init_failed' };
      store.close();
      socket.send(JSON.stringify({
        type: 'send-ack',
        messageId: message.messageId || null,
        ok: journal.ok === true,
        accepted: journal.ok === true,
        queued: journal.ok === true,
        verified: journal.ok === true,
        status: journal.ok ? 'delivered.verified' : 'handler_error',
        error: journal.ok ? null : (journal.reason || journal.status || 'journal_write_failed'),
        timestamp: Date.now(),
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    server,
    port: server.address().port,
    async close() {
      for (const client of server.clients) {
        try { client.terminate(); } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('Build 1A isolated daemon liveness gate', () => {
  jest.setTimeout(30_000);

  test('real race, own-pane journal proof, app reconnect, external death, and lease reclaim', async () => {
    const token = `${process.pid}-${Date.now()}`;
    const profileName = `build1a-test-copy-${token}`;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-build1a-live-'));
    const dbPath = path.join(dataRoot, '.squidrun', 'runtime', 'evidence-ledger.db');
    const pipePath = getProfilePipePath(profileName, os.platform(), { dataRoot });
    const uiRoot = path.resolve(__dirname, '..');
    const projectRoot = path.resolve(uiRoot, '..');
    const daemonPath = path.join(uiRoot, 'terminal-daemon.js');
    const fixturePath = path.join(__dirname, 'fixtures', 'arm-liveness-responder.js');
    const hmSendPath = path.join(uiRoot, 'scripts', 'hm-send.js');
    const paneCommand = quotePaneCommand(process.execPath, fixturePath);
    const broker = await startQaCommsBroker({
      dbPath,
      paneId: 'exampleapp-dev-qa-test-copy',
      profileName,
    });
    const daemon = spawn(process.execPath, [daemonPath], {
      cwd: uiRoot,
      env: {
        ...process.env,
        SQUIDRUN_PROFILE: profileName,
        SQUIDRUN_DATA_ROOT: dataRoot,
        SQUIDRUN_PROJECT_ROOT: projectRoot,
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    const clientA = new DaemonClient({ pipePath, profileName });
    const clientB = new DaemonClient({ pipePath, profileName });
    let restartClient = null;
    let currentSpawn = null;

    try {
      expect(await connectClient(clientA)).toBe(true);
      expect(await connectClient(clientB)).toBe(true);

      const sharedInput = {
        dbPath,
        workspacePath: projectRoot,
        profileName,
        appRoomId: 'exampleapp-build-1a-qa',
        armKey: 'dev-qa',
        paneId: 'exampleapp-dev-qa-test-copy',
        role: 'exampleapp-dev-qa',
        owner: 'terminal-daemon',
        recoveryEvent: 'lease_check_on_spawn',
        expectedResponseClass: 'arm.liveness.pong',
        mainSessionId: 'app-session-build-1a-test-copy-1',
        env: {
          SQUIDRUN_BUILD1A_HM_SEND: hmSendPath,
          HM_SEND_PORT: String(broker.port),
          SQUIDRUN_SESSION_SCOPE_ID: 'app-session-build-1a-test-copy-1',
        },
        options: {
          paneCommand,
          spawnCommandOnCreate: true,
        },
        metadata: {
          qaInstanceClass: 'throwaway',
          qaInstanceTitle: 'Build 1A TEST COPY',
        },
      };
      const durableAddress = buildArmDurableAddress(sharedInput);
      const [attemptA, attemptB] = await Promise.all([
        spawnArmWithAtomicSession({ ...sharedInput, sourceMessageId: 'qa-race-ping-a' }, { daemonClient: clientA }),
        spawnArmWithAtomicSession({ ...sharedInput, sourceMessageId: 'qa-race-ping-b' }, { daemonClient: clientB }),
      ]);
      const winner = attemptA.ok ? attemptA : attemptB;
      const loser = attemptA.ok ? attemptB : attemptA;
      const winnerClient = attemptA.ok ? clientA : clientB;
      currentSpawn = winner;

      const winnerCount = [attemptA.ok, attemptB.ok].filter(Boolean).length;
      if (winnerCount !== 1) {
        throw new Error(`expected one race winner: ${JSON.stringify({ attemptA, attemptB })}`);
      }
      expect(winner).toEqual(expect.objectContaining({
        ok: true,
        status: 'spawned_and_registered',
        durableAddress,
        session: expect.objectContaining({
          status: 'active',
          metadata: expect.objectContaining({
            qaInstanceClass: 'throwaway',
            qaInstanceTitle: 'Build 1A TEST COPY',
          }),
        }),
      }));
      expect(loser).toEqual(expect.objectContaining({
        ok: false,
        status: 'refused',
        reason: 'address_lease_held',
      }));
      expect(queryArmSpawnSessions({ durableAddress }, { dbPath })).toHaveLength(1);

      const firstProof = await probeArmLiveness({
        dbPath,
        session: winner.session,
        proofTimeoutMs: 7_500,
        pollIntervalMs: 50,
      }, { daemonClient: winnerClient, dbPath });
      expect(firstProof).toEqual(expect.objectContaining({
        ok: true,
        status: 'proved',
        session: expect.objectContaining({
          spawnLeaseId: winner.spawnLeaseId,
          livenessMessageId: expect.stringMatching(/^hm-/),
          livenessRowId: expect.any(Number),
        }),
      }));
      expect(firstProof.proof.comms).toEqual(expect.objectContaining({
        status: 'routed',
        ackStatus: 'delivered.verified',
        metadata: expect.objectContaining({
          source: 'build-1a-test-copy-qa-broker',
          sender: expect.objectContaining({ pane_id: 'exampleapp-dev-qa-test-copy' }),
        }),
      }));

      clientA.disconnect();
      clientB.disconnect();
      restartClient = new DaemonClient({ pipePath, profileName });
      const lifecycleReceipts = [];
      restartClient.on('kernel-event', (eventData) => {
        if (!String(eventData?.type || '').startsWith('arm.spawn.')) return;
        if (eventData.type === 'arm.spawn.started') return;
        lifecycleReceipts.push(eventData);
        recordArmSpawnLifecycle({
          eventClass: eventData.type,
          receipt: eventData.payload,
          mainSessionId: 'app-session-build-1a-test-copy-2',
          paneId: eventData.paneId,
        }, { dbPath });
      });
      expect(await connectClient(restartClient)).toBe(true);
      const reattached = await waitFor(() => restartClient.getTerminal(sharedInput.paneId), 3_000);
      expect(reattached).toEqual(expect.objectContaining({
        alive: true,
        durableAddress,
        spawnLeaseId: winner.spawnLeaseId,
      }));
      expect(queryArmSpawnSessions({ durableAddress }, { dbPath })[0]).toEqual(expect.objectContaining({
        spawnLeaseId: winner.spawnLeaseId,
        livenessMessageId: firstProof.session.livenessMessageId,
      }));

      killProcessTree(reattached.pid);
      const released = await waitFor(() => {
        const rows = queryArmSpawnSessions({ durableAddress }, { dbPath });
        return rows.find((row) => row.spawnLeaseId === winner.spawnLeaseId && row.status === 'released') || null;
      }, 7_500);
      expect(released).toEqual(expect.objectContaining({
        spawnLeaseId: winner.spawnLeaseId,
        status: 'released',
        lastLifecycleEvent: 'arm.spawn.released',
      }));
      expect(lifecycleReceipts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'arm.spawn.released',
          payload: expect.objectContaining({
            reason: 'process_exit',
            spawnLeaseId: winner.spawnLeaseId,
            recoveryEvent: 'pty_exit',
          }),
        }),
      ]));

      const replacement = await spawnArmWithAtomicSession({
        ...sharedInput,
        sourceMessageId: 'qa-restart-ping-2',
        mainSessionId: 'app-session-build-1a-test-copy-2',
        env: {
          ...sharedInput.env,
          SQUIDRUN_SESSION_SCOPE_ID: 'app-session-build-1a-test-copy-2',
        },
      }, { daemonClient: restartClient });
      currentSpawn = replacement;
      expect(replacement).toEqual(expect.objectContaining({
        ok: true,
        status: 'spawned_and_registered',
        durableAddress,
        spawnLeaseId: expect.not.stringMatching(new RegExp(`^${winner.spawnLeaseId}$`)),
        session: expect.objectContaining({
          previousSpawnLeaseId: winner.spawnLeaseId,
          status: 'active',
        }),
      }));
      const replacementProof = await probeArmLiveness({
        dbPath,
        session: replacement.session,
        proofTimeoutMs: 7_500,
        pollIntervalMs: 50,
      }, { daemonClient: restartClient, dbPath });
      expect(replacementProof).toEqual(expect.objectContaining({
        ok: true,
        status: 'proved',
        session: expect.objectContaining({
          spawnLeaseId: replacement.spawnLeaseId,
          previousSpawnLeaseId: winner.spawnLeaseId,
          livenessMessageId: expect.stringMatching(/^hm-/),
        }),
      }));
      expect(queryArmSpawnSessions({ durableAddress, order: 'asc' }, { dbPath })).toEqual([
        expect.objectContaining({ spawnLeaseId: winner.spawnLeaseId, status: 'released' }),
        expect.objectContaining({
          spawnLeaseId: replacement.spawnLeaseId,
          previousSpawnLeaseId: winner.spawnLeaseId,
          status: 'active',
        }),
      ]);
    } finally {
      const cleanupClient = restartClient?.connected
        ? restartClient
        : (clientA.connected ? clientA : (clientB.connected ? clientB : null));
      if (cleanupClient && currentSpawn?.spawnLeaseId) {
        try {
          await cleanupClient.killAddressed({
            durableAddress: currentSpawn.durableAddress,
            spawnLeaseId: currentSpawn.spawnLeaseId,
            paneId: currentSpawn.session?.paneId || 'exampleapp-dev-qa-test-copy',
            reason: 'qa_verified_teardown',
          });
        } catch {}
      }
      if (cleanupClient?.connected) cleanupClient.shutdown();
      clientA.disconnect();
      clientB.disconnect();
      restartClient?.disconnect();
      let exitResult = await waitForExit(daemon);
      if (!exitResult.exited) {
        daemon.kill('SIGTERM');
        exitResult = await waitForExit(daemon);
      }
      expect(exitResult.exited).toBe(true);
      closeArmSpawnJournalStores();
      closeCommsJournalStores();
      await broker.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
