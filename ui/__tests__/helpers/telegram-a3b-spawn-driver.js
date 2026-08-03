/**
 * DRIVE THE REAL PANE-SPAWN PATH IN A CHILD PROCESS.
 *
 * Not a test helper that reimplements the path — the path itself. `pty-create`
 * is registered from the production module, handed a REAL `DaemonClient`, and
 * the only thing replaced is `_send`, which is the socket write to the daemon.
 * That is a process boundary, not a step of the logic under test: everything
 * from the pane command through `detectCliFromCommand`, the spawn options, the
 * launch registry and the ledger write is the shipped code.
 *
 * A CHILD PROCESS AND NOT AN IN-PROCESS CALL, because `config.js` resolves the
 * project root once at require time. Jest cannot un-require it, so a temp root
 * has to be established before the first import — which is what a fresh process
 * gives for free, and it also proves the path works from a cold start rather
 * than from a module graph a test warmed up.
 *
 * Usage: node telegram-a3b-spawn-driver.js <tempRoot> <paneCommand> [appGeneration]
 * Prints one line of JSON on stdout.
 */
const path = require('node:path');

const [, , tempRoot, paneCommand, appGeneration] = process.argv;

process.env.SQUIDRUN_PROJECT_ROOT = tempRoot;
delete process.env.SQUIDRUN_DATA_ROOT;
delete process.env.SQUIDRUN_PROFILE;
if (appGeneration === undefined) {
  delete process.env.SQUIDRUN_APP_GENERATION;
} else {
  process.env.SQUIDRUN_APP_GENERATION = appGeneration;
}

const UI_ROOT = path.resolve(__dirname, '..', '..');

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

(async () => {
  try {
    const { DaemonClient } = require(path.join(UI_ROOT, 'daemon-client.js'));
    const { registerPtyHandlers } = require(path.join(UI_ROOT, 'modules', 'ipc', 'pty-handlers.js'));

    const client = new DaemonClient({});
    client.connected = true;
    let sentPayload = null;
    client._send = (payload) => { sentPayload = payload; return true; };

    const handlers = new Map();
    registerPtyHandlers({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: () => {} },
      daemonClient: client,
      currentSettings: { dryRun: false, operatingMode: 'developer' },
    }, {});

    const create = handlers.get('pty-create');
    if (typeof create !== 'function') {
      emit({ ok: false, reason: 'pty_create_handler_missing' });
      return;
    }

    const result = await create({ sender: { id: 1 } }, '1', tempRoot, { paneCommand });

    emit({
      ok: result && result.success === true,
      createResult: result || null,
      spawnSent: sentPayload !== null,
      // WHAT THE PANE WOULD REALLY INHERIT. The launch id only means anything
      // because it travels in this environment; a row written without the
      // hand-off is a record no hook can ever name.
      launchId: sentPayload && sentPayload.env
        ? (sentPayload.env.SQUIDRUN_PANE_LAUNCH_ID || null) : null,
      appGeneration: sentPayload && sentPayload.env
        ? (sentPayload.env.SQUIDRUN_APP_GENERATION || null) : null,
      paneCommandSent: sentPayload && sentPayload.options
        ? (sentPayload.options.paneCommand || null) : null,
      modeSent: sentPayload ? (sentPayload.mode ?? null) : null,
    });
  } catch (err) {
    emit({ ok: false, reason: 'driver_threw', message: err.message, stack: err.stack });
  }
})();
