'use strict';

/**
 * Headless-harness bootstrap for offscreen Electron audit/probe rigs.
 *
 * REQUIRED FIRST by every replica/probe script that runs under electron.exe
 * outside the live app (S426 incident: replica rigs hit EPIPE on console.log
 * after the parent pipe closed, and Electron's DEFAULT uncaughtException
 * handler popped a native error dialog on James's desktop PER process).
 *
 * Guarantees, by construction:
 * - no native dialogs, ever (uncaughtException handled; showErrorBox no-op);
 * - stdout/stderr writes can never throw (EPIPE swallowed);
 * - everything logged lands in a file regardless of pipe state;
 * - the process is marked as a headless harness via env.
 *
 * Usage:
 *   const harness = require('<repo>/ui/scripts/headless-harness-bootstrap');
 *   harness.init({ name: 'ux-audit-replica' });
 *   harness.log('captured frame x');
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let logPath = path.join(os.tmpdir(), 'squidrun-headless-harness.log');
let initialized = false;

function fileLog(line) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch (_) { /* never throw from logging */ }
}

function guardStream(stream) {
  if (!stream || typeof stream.on !== 'function') return;
  // Swallow EPIPE & friends: a closed parent pipe must never kill the rig.
  stream.on('error', () => {});
}

function log(line) {
  fileLog(line);
  try {
    process.stdout.write(`${line}\n`);
  } catch (_) { /* pipe may be closed; the file has it */ }
}

function init(options = {}) {
  if (initialized) return { logPath };
  initialized = true;
  const name = String(options.name || 'harness').replace(/[^A-Za-z0-9_-]/g, '-');
  logPath = options.logPath
    || path.join(os.tmpdir(), `squidrun-harness-${name}-${process.pid}.log`);
  process.env.SQUIDRUN_HEADLESS_HARNESS = '1';

  guardStream(process.stdout);
  guardStream(process.stderr);

  process.on('uncaughtException', (err) => {
    fileLog(`UNCAUGHT: ${err?.stack || err}`);
    try {
      // app may not be ready/required yet; exit hard either way, silently.
      const { app } = require('electron');
      app.exit(1);
    } catch (_) {
      process.exit(1);
    }
  });
  process.on('unhandledRejection', (reason) => {
    fileLog(`UNHANDLED REJECTION: ${reason?.stack || reason}`);
  });

  try {
    const { dialog, app } = require('electron');
    const muzzle = () => {
      if (dialog) {
        dialog.showErrorBox = () => {};
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
        dialog.showMessageBoxSync = () => 0;
      }
    };
    if (app?.isReady?.()) muzzle();
    else app?.whenReady?.().then(muzzle).catch(() => {});
    muzzle();
  } catch (_) { /* not under electron - stream/exception guards still hold */ }

  fileLog(`harness init: ${name} pid=${process.pid}`);
  return { logPath };
}

module.exports = { init, log, getLogPath: () => logPath };
