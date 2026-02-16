/**
 * WebSocket server facade.
 * Default mode runs comms in a worker process; optional in-process mode for debugging/tests.
 */

const runtime = require('./websocket-runtime');
const workerClient = require('./comms-worker-client');

const FORCE_IN_PROCESS = process.env.HIVEMIND_COMMS_FORCE_IN_PROCESS === '1';
const USE_WORKER_MODE = process.env.HIVEMIND_COMMS_USE_WORKER === '1';

async function start(options = {}) {
  if (FORCE_IN_PROCESS || !USE_WORKER_MODE) {
    return runtime.start(options);
  }
  return workerClient.start(options);
}

async function stop() {
  if (FORCE_IN_PROCESS || !USE_WORKER_MODE) {
    return runtime.stop();
  }
  return workerClient.stop();
}

function isRunning() {
  if (FORCE_IN_PROCESS || !USE_WORKER_MODE) {
    return runtime.isRunning();
  }
  return workerClient.isRunning();
}

function getPort() {
  if (FORCE_IN_PROCESS || !USE_WORKER_MODE) {
    return runtime.getPort();
  }
  return workerClient.getPort();
}

function getClients() {
  if (FORCE_IN_PROCESS || !USE_WORKER_MODE) {
    return runtime.getClients();
  }
  return workerClient.getClients();
}

function sendToTarget(target, content, meta = {}) {
  if (FORCE_IN_PROCESS || !USE_WORKER_MODE) {
    return runtime.sendToTarget(target, content, meta);
  }
  return workerClient.sendToTarget(target, content, meta);
}

function sendToPane(paneId, content, meta = {}) {
  if (FORCE_IN_PROCESS || !USE_WORKER_MODE) {
    return runtime.sendToPane(paneId, content, meta);
  }
  return workerClient.sendToPane(paneId, content, meta);
}

function broadcast(content, options = {}) {
  if (FORCE_IN_PROCESS || !USE_WORKER_MODE) {
    return runtime.broadcast(content, options);
  }
  return workerClient.broadcast(content, options);
}

module.exports = {
  start,
  stop,
  isRunning,
  getPort,
  getClients,
  sendToTarget,
  sendToPane,
  broadcast,
  DEFAULT_PORT: runtime.DEFAULT_PORT,
};
