/**
 * Owns inbound channel poller lifecycle for the main process.
 *
 * This keeps SquidRunApp focused on message handling while giving pollers a
 * single boundary that can later move out of the Electron process.
 */

const path = require('path');
const { fork } = require('child_process');
const log = require('../logger');
const smsPoller = require('../sms-poller');
const telegramPoller = require('../telegram-poller');

const TELEGRAM_WORKER_PATH = path.join(__dirname, 'telegram-poller-worker.js');
const TELEGRAM_STOP_KILL_TIMEOUT_MS = 2000;

class InboundPollerService {
  constructor(dependencies = {}) {
    this.smsPoller = dependencies.smsPoller || smsPoller;
    this.telegramPoller = dependencies.telegramPoller || telegramPoller;
    this.forkProcess = dependencies.forkProcess || fork;
    this.log = dependencies.log || log;
    this.telegramWorkerPath = dependencies.telegramWorkerPath || TELEGRAM_WORKER_PATH;
    this.useTelegramWorker = dependencies.useTelegramWorker !== undefined
      ? dependencies.useTelegramWorker !== false
      : process.env.NODE_ENV !== 'test';
    this.telegramWorker = null;
    this.telegramOnMessage = null;
  }

  startSms(options = {}) {
    return this.smsPoller.start(options);
  }

  startTelegram(options = {}) {
    if (!this.useTelegramWorker) {
      return this.telegramPoller.start(options);
    }

    const getTelegramConfig = this.telegramPoller?._internals?.getTelegramConfig;
    if (typeof getTelegramConfig === 'function' && !getTelegramConfig(options.env || process.env)) {
      return false;
    }

    this.stopTelegramWorker();
    if (this.telegramPoller && typeof this.telegramPoller.stop === 'function') {
      this.telegramPoller.stop();
    }

    this.telegramOnMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    const worker = this.forkProcess(this.telegramWorkerPath, [], {
      env: {
        ...process.env,
        SQUIDRUN_TELEGRAM_POLLER_WORKER: '1',
      },
    });
    worker.__squidrunIntentionalStop = false;
    this.telegramWorker = worker;

    if (typeof worker.on === 'function') {
      worker.on('message', (message) => this.handleTelegramWorkerMessage(worker, message));
      worker.on('error', (err) => {
        this.log.warn('Telegram', `Telegram poller worker error: ${err.message}`);
      });
      worker.on('exit', (code, signal) => {
        const intentional = worker.__squidrunIntentionalStop === true;
        if (this.telegramWorker === worker) {
          this.telegramWorker = null;
        }
        if (intentional) {
          this.log.info('Telegram', `Telegram poller worker stopped (${signal || code || 'exit'})`);
        } else {
          this.log.error('Telegram', `Telegram poller worker exited unexpectedly (code=${code}, signal=${signal || 'none'})`);
        }
      });
    }

    const workerOptions = {
      env: options.env || process.env,
      pollIntervalMs: options.pollIntervalMs,
      downloadMedia: options.downloadMedia,
      mediaDownloadRoot: options.mediaDownloadRoot,
      latestScreenshotPath: options.latestScreenshotPath,
    };

    try {
      worker.send({
        type: 'start',
        options: workerOptions,
      });
    } catch (err) {
      this.log.warn('Telegram', `Failed starting Telegram poller worker: ${err.message}`);
      this.stopTelegramWorker();
      return false;
    }

    return true;
  }

  stopSms() {
    if (this.smsPoller && typeof this.smsPoller.stop === 'function') {
      this.smsPoller.stop();
    }
  }

  stopTelegram() {
    if (this.useTelegramWorker) {
      this.stopTelegramWorker();
    } else if (this.telegramPoller && typeof this.telegramPoller.stop === 'function') {
      this.telegramPoller.stop();
    }
  }

  stopAll() {
    this.stopSms();
    this.stopTelegram();
  }

  handleTelegramWorkerMessage(worker, message) {
    if (worker !== this.telegramWorker || !message || typeof message !== 'object') return;

    if (message.type === 'message') {
      const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
      if (typeof this.telegramOnMessage === 'function') {
        try {
          this.telegramOnMessage(payload.text, payload.from, payload.metadata || {});
        } catch (err) {
          this.log.warn('Telegram', `Telegram poller worker callback failed: ${err.message}`);
        }
      }
      return;
    }

    if (message.type === 'started') {
      if (message.started) {
        this.log.info('Telegram', 'Telegram poller worker started');
      } else {
        this.log.warn('Telegram', `Telegram poller worker did not start (${message.reason || 'unknown'})`);
      }
      return;
    }

    if (message.type === 'log' && message.level && message.message) {
      const level = typeof this.log[message.level] === 'function' ? message.level : 'info';
      this.log[level]('Telegram', message.message);
    }
  }

  stopTelegramWorker() {
    const worker = this.telegramWorker;
    this.telegramWorker = null;
    this.telegramOnMessage = null;
    if (!worker) return;

    worker.__squidrunIntentionalStop = true;
    try {
      if (typeof worker.send === 'function' && worker.connected !== false) {
        worker.send({ type: 'shutdown' });
      }
    } catch (err) {
      this.log.warn('Telegram', `Failed sending Telegram poller worker shutdown: ${err.message}`);
    }

    setTimeout(() => {
      try {
        if (typeof worker.kill === 'function' && worker.killed !== true) {
          worker.kill();
        }
      } catch {
        // Best effort only.
      }
    }, TELEGRAM_STOP_KILL_TIMEOUT_MS).unref?.();
  }
}

function createInboundPollerService(dependencies = {}) {
  return new InboundPollerService(dependencies);
}

module.exports = {
  InboundPollerService,
  createInboundPollerService,
};
