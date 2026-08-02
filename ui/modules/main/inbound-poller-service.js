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
const { buildNodeWorkerForkOptions } = require('../node-worker-fork-options');

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
    this.telegramWorkerGeneration = 0;
    this.telegramWorkerStateGeneration = 0;
    this.telegramWorkerState = {
      phase: 'idle',
      ready: false,
      reason: null,
    };
  }

  startSms(options = {}) {
    return this.smsPoller.start(options);
  }

  startTelegram(options = {}) {
    if (!this.useTelegramWorker) {
      const started = this.telegramPoller.start(options);
      this.telegramWorkerState = {
        phase: started ? 'ready' : 'failed',
        ready: started === true,
        reason: started ? null : 'missing_config',
      };
      return started;
    }

    const workerEnv = {
      ...process.env,
      ...(options.env || {}),
      SQUIDRUN_TELEGRAM_POLLER_WORKER: '1',
    };

    const getTelegramConfig = this.telegramPoller?._internals?.getTelegramConfig;
    if (typeof getTelegramConfig === 'function' && !getTelegramConfig(workerEnv)) {
      this.telegramWorkerState = {
        phase: 'failed',
        ready: false,
        reason: 'missing_config',
      };
      return false;
    }

    this.stopTelegramWorker();
    if (this.telegramPoller && typeof this.telegramPoller.stop === 'function') {
      this.telegramPoller.stop();
    }

    this.telegramOnMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    const worker = this.forkProcess(this.telegramWorkerPath, [], buildNodeWorkerForkOptions({
      env: workerEnv,
    }));
    worker.__squidrunIntentionalStop = false;
    worker.__squidrunWorkerGeneration = ++this.telegramWorkerGeneration;
    this.telegramWorker = worker;
    this.telegramWorkerStateGeneration = worker.__squidrunWorkerGeneration;
    this.telegramWorkerState = {
      phase: 'spawned',
      ready: false,
      reason: null,
    };

    if (typeof worker.on === 'function') {
      worker.on('message', (message) => this.handleTelegramWorkerMessage(worker, message));
      worker.on('error', (err) => {
        this.log.warn('Telegram', `Telegram poller worker error: ${err.message}`);
      });
      worker.on('exit', (code, signal) => {
        const intentional = worker.__squidrunIntentionalStop === true;
        const isCurrentWorker = this.telegramWorker === worker;
        const ownsStoppedSlot = (
          intentional
          && this.telegramWorker === null
          && this.telegramWorkerState.phase === 'stopping'
          && this.telegramWorkerStateGeneration === worker.__squidrunWorkerGeneration
        );
        if (isCurrentWorker) {
          this.telegramWorker = null;
        }
        if (intentional) {
          if (isCurrentWorker || ownsStoppedSlot) {
            this.telegramWorkerState = {
              phase: 'idle',
              ready: false,
              reason: 'intentional_stop',
            };
          }
          this.log.info('Telegram', `Telegram poller worker stopped (${signal || code || 'exit'})`);
        } else {
          if (isCurrentWorker) {
            this.telegramWorkerState = {
              phase: 'failed',
              ready: false,
              reason: this.telegramWorkerState.reason || `worker_exit:${signal || code || 'unknown'}`,
            };
          }
          this.log.error('Telegram', `Telegram poller worker exited unexpectedly (code=${code}, signal=${signal || 'none'})`);
        }
      });
    }

    const workerOptions = {
      env: workerEnv,
      pollIntervalMs: options.pollIntervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
      downloadMedia: options.downloadMedia,
      mediaDownloadRoot: options.mediaDownloadRoot,
      latestScreenshotPath: options.latestScreenshotPath,
      keepAlive: true,
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
      this.telegramWorkerState = {
        phase: 'idle',
        ready: false,
        reason: 'intentional_stop',
      };
    }
  }

  stopAll() {
    this.stopSms();
    this.stopTelegram();
  }

  /**
   * Await the app callback and ack the worker ONLY on explicit durable
   * acceptance.
   *
   * The worker's callback is what the Telegram poller awaits, and since
   * 345c4311 a rejection holds the cursor. So a positive ack here is a promise
   * that the message is recoverable without Telegram. Anything less — a throw,
   * a falsy or malformed result, `durable !== true`, or a failed ack send —
   * must leave the worker unresolved so it times out and the cursor holds.
   * Never ack because the callback merely returned.
   */
  async deliverTelegramInbound(worker, ackKey, payload) {
    const nack = (reason) => {
      if (!ackKey) return;
      this.sendTelegramAck(worker, { ackKey, ok: false, reason });
    };

    if (typeof this.telegramOnMessage !== 'function') {
      this.log.warn('Telegram', 'Telegram inbound arrived with no app consumer; holding cursor');
      nack('no_consumer');
      return;
    }

    let result;
    try {
      result = await this.telegramOnMessage(payload.text, payload.from, payload.metadata || {});
    } catch (err) {
      this.log.warn('Telegram', `Telegram inbound callback failed: ${err.message}`);
      nack(`callback_threw:${err.message}`);
      return;
    }

    if (!result || typeof result !== 'object' || result.ok !== true || result.durable !== true) {
      const reason = (result && typeof result === 'object' && result.reason) || 'not_durable';
      this.log.warn('Telegram', `Telegram inbound not durably accepted (${reason}); holding cursor`);
      nack(reason);
      return;
    }

    this.sendTelegramAck(worker, { ackKey, ok: true, durable: true });
  }

  /** Ack send failure must NOT be treated as delivery; the worker times out. */
  sendTelegramAck(worker, message) {
    if (!message.ackKey) return false;
    try {
      if (worker !== this.telegramWorker || !worker || worker.killed || typeof worker.send !== 'function') {
        return false;
      }
      worker.send({ type: 'message-ack', ...message });
      return true;
    } catch (err) {
      this.log.warn('Telegram', `Failed sending Telegram ack ${message.ackKey}: ${err.message}`);
      return false;
    }
  }

  handleTelegramWorkerMessage(worker, message) {
    if (worker !== this.telegramWorker || !message || typeof message !== 'object') return;

    if (message.type === 'message') {
      const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
      this.deliverTelegramInbound(worker, message.ackKey, payload);
      return;
    }

    if (message.type === 'started') {
      this.telegramWorkerStateGeneration = worker.__squidrunWorkerGeneration || 0;
      this.telegramWorkerState = {
        phase: message.started ? 'ready' : 'failed',
        ready: message.started === true,
        reason: message.started ? null : (message.reason || 'unknown'),
      };
      if (message.started) {
        this.log.info('Telegram', 'Telegram poller worker started');
      } else {
        this.log.warn('Telegram', `Telegram poller worker did not start (${message.reason || 'unknown'})`);
      }
      return;
    }

    if (message.type === 'starting') {
      this.telegramWorkerStateGeneration = worker.__squidrunWorkerGeneration || 0;
      this.telegramWorkerState = {
        phase: message.phase || 'starting',
        ready: false,
        reason: null,
      };
      this.log.info(
        'Telegram',
        `Telegram poller worker waiting for ${message.phase || 'startup readiness'}`
      );
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
    if (!worker) {
      this.telegramWorkerState = {
        phase: 'idle',
        ready: false,
        reason: 'intentional_stop',
      };
      return;
    }

    worker.__squidrunIntentionalStop = true;
    this.telegramWorkerStateGeneration = worker.__squidrunWorkerGeneration || 0;
    this.telegramWorkerState = {
      phase: 'stopping',
      ready: false,
      reason: 'intentional_stop',
    };
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

  getTelegramWorkerState() {
    return { ...this.telegramWorkerState };
  }
}

function createInboundPollerService(dependencies = {}) {
  return new InboundPollerService(dependencies);
}

module.exports = {
  InboundPollerService,
  createInboundPollerService,
};
