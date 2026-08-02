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
    // A child asked to stop whose exit has NOT yet been observed.
    this.telegramRetiringWorker = null;
    this.telegramWorkerStateGeneration = 0;
    this.telegramStopInFlight = null;
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
    // Either of these is how two getUpdates children end up alive at once: a
    // start racing an in-flight stop, or a start that fire-and-forget stops a
    // LIVE worker and forks immediately. Callers must stop and await first.
    if (this.telegramStopInFlight) {
      this.log.warn('Telegram', 'Refusing Telegram start: a worker stop is still in flight');
      return { accepted: false, phase: 'blocked', ready: false, reason: 'stop_in_flight' };
    }
    if (this.useTelegramWorker && this.telegramRetiringWorker) {
      this.log.warn('Telegram', 'Refusing Telegram start: a retiring worker has not been observed to exit');
      return {
        accepted: false, phase: 'blocked', ready: false, reason: 'retiring_worker_exit_unproven',
      };
    }
    if (this.useTelegramWorker && this.telegramWorker) {
      this.log.warn('Telegram', 'Refusing Telegram start: a worker is already live');
      return { accepted: false, phase: 'blocked', ready: false, reason: 'worker_already_live' };
    }
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
        // The child's REAL exit is the only thing that may lower the retiring
        // fence, and only for the exact child it was raised for. A stop that
        // TIMED OUT leaves it up on purpose: an unreferenced live child is how
        // a second poller gets forked onto the same cursor.
        if (this.telegramRetiringWorker === worker) {
          this.telegramRetiringWorker = null;
        }
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
      // The child is ALREADY FORKED. A failed start-send says nothing about
      // whether it is alive, and stopTelegramWorker clears the only reference
      // to it, so an immediate retry would fork a second getUpdates child onto
      // the same cursor. Fence it first; only its observed exit lowers that.
      this.telegramRetiringWorker = worker;
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

  /**
   * PUBLIC stop, awaitable, for BOTH owner modes.
   *
   * The worker path resolves only on an OBSERVED exit; the in-process path is
   * synchronous and already stopped once stop() returns. Callers that are about
   * to start a replacement must await this — routing them at the worker-only
   * seam regressed useTelegramWorker=false entirely.
   *
   * @returns {Promise<{ok: boolean, exited: boolean, reason?: string}>}
   */
  stopTelegram(options = {}) {
    if (this.useTelegramWorker) {
      return this.stopTelegramWorkerAndWait(options);
    }
    if (this.telegramPoller && typeof this.telegramPoller.stop === 'function') {
      this.telegramPoller.stop();
      this.telegramWorkerState = {
        phase: 'idle',
        ready: false,
        reason: 'intentional_stop',
      };
      return Promise.resolve({ ok: true, exited: true, reason: 'in_process_stopped' });
    }
    return Promise.resolve({ ok: true, exited: true, reason: 'no_poller' });
  }

  /**
   * Awaitable teardown of every intake. Callers in the shutdown path MUST await
   * this: returning before the Telegram child is observed to exit orphans the
   * getUpdates owner.
   */
  stopAll() {
    this.stopSms();
    // The REAL promise, unmasked: a swallowed rejection or a discarded
    // {ok:false} would tell the shutdown path the child is gone when it is not.
    return this.stopTelegram();
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

    // EXACT CORRELATION. An ack is a claim about one specific update, so the key
    // we release must match the update the callback says it made durable AND the
    // update the worker actually sent. Without this, a result carrying the wrong
    // id would release the wrong message's cursor — a loss that looks like a
    // success on both sides.
    const payloadUpdateId = Number(payload?.metadata?.updateId);
    const resultUpdateId = Number(result.updateId);
    if (!Number.isFinite(resultUpdateId) || !Number.isFinite(payloadUpdateId)
      || resultUpdateId !== payloadUpdateId
      || ackKey !== `telegram-in-${resultUpdateId}`) {
      this.log.warn(
        'Telegram',
        `Telegram ack correlation mismatch (ackKey=${ackKey} result=${result.updateId} payload=${payload?.metadata?.updateId}); holding cursor`
      );
      nack('ack_correlation_mismatch');
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


  /**
   * Stop the Telegram worker and WAIT until its exit is actually observed.
   *
   * The old stopTelegramWorker fired `shutdown`, scheduled a kill 2s later, and
   * returned immediately — so a caller that forked a replacement right after
   * could transiently have TWO getUpdates children alive. Two pollers on one
   * cursor is the duplicate-delivery bug this whole lane exists to prevent.
   *
   * Graceful first, then kill, then a bounded wait. If exit is still not
   * observed, this FAILS and the caller must not fork: an unobserved child is
   * indistinguishable from a live one.
   *
   * @returns {Promise<{ok: boolean, exited: boolean, reason?: string}>}
   */
  stopTelegramWorkerAndWait(options = {}) {
    if (this.telegramStopInFlight) return this.telegramStopInFlight;

    const graceMs = Number.isFinite(Number(options.graceMs))
      ? Number(options.graceMs)
      : TELEGRAM_STOP_KILL_TIMEOUT_MS;
    const killWaitMs = Number.isFinite(Number(options.killWaitMs))
      ? Number(options.killWaitMs)
      : TELEGRAM_STOP_KILL_TIMEOUT_MS;

    // A previous stop may have TIMED OUT, leaving a possibly-live child with
    // no this.telegramWorker reference. Reporting "no_worker" here would be
    // fail-open: the caller would take it as proof and fork.
    const worker = this.telegramWorker || this.telegramRetiringWorker;
    if (!worker) {
      this.stopTelegramWorker();
      return Promise.resolve({ ok: true, exited: true, reason: 'no_worker' });
    }
    this.telegramRetiringWorker = worker;

    const pending = new Promise((resolve) => {
      let settled = false;
      let graceTimer = null;
      let killTimer = null;

      const onExit = () => finish({ ok: true, exited: true });
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        if (killTimer) clearTimeout(killTimer);
        // Terminal either way — including timeout, where the fence stays up but
        // THIS attempt's listener must not leak across repeated restarts.
        if (typeof worker.removeListener === 'function') {
          worker.removeListener('exit', onExit);
        }
        resolve(result);
      };

      // The ONLY thing that counts as stopped.
      worker.once('exit', onExit);

      this.stopTelegramWorker({ skipKillSchedule: true });

      // The child can emit exit SYNCHRONOUSLY from that shutdown send. finish()
      // then ran with both timers still null, so arming here would leave a live
      // timer past settlement — one that later kills whatever child occupies
      // the slot, which by then may be the replacement.
      if (settled) return;

      graceTimer = setTimeout(() => {
        try {
          if (typeof worker.kill === 'function' && worker.killed !== true) worker.kill();
        } catch {
          // Best effort; the bounded wait below is what decides the outcome.
        }
        // kill() can emit exit SYNCHRONOUSLY. finish() then ran with killTimer
        // still null, so arming here leaves a timer past settlement — exactly
        // the race guarded above, one stage later.
        if (settled) return;

        killTimer = setTimeout(
          () => finish({ ok: false, exited: false, reason: 'exit_not_observed' }),
          killWaitMs
        );
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }, graceMs);
      if (typeof graceTimer.unref === 'function') graceTimer.unref();
    }).finally(() => {
      // Identity-guarded: only the promise that OWNS the latch may clear it.
      // An unconditional clear lets a late settler wipe a newer stop's latch,
      // reopening the start-during-stop race this latch exists to close.
      if (this.telegramStopInFlight === pending) {
        this.telegramStopInFlight = null;
      }
    });

    this.telegramStopInFlight = pending;
    return pending;
  }

  stopTelegramWorker(options = {}) {
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

    // Only schedule a kill when nobody is already managing one. The awaited
    // path arms its own kill plus a bounded wait; two schedules against the
    // same child is redundant at best and confusing at worst.
    if (options.skipKillSchedule === true) return;
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
