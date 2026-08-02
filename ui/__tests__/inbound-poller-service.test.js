const { createInboundPollerService } = require('../modules/main/inbound-poller-service');
const { EventEmitter } = require('events');

describe('InboundPollerService', () => {
  test('starts and stops inbound channel pollers through injected dependencies', () => {
    const smsPoller = {
      start: jest.fn(() => true),
      stop: jest.fn(),
    };
    const telegramPoller = {
      start: jest.fn(() => true),
      stop: jest.fn(),
    };
    const service = createInboundPollerService({
      smsPoller,
      telegramPoller,
      useTelegramWorker: false,
    });
    const smsOptions = { onMessage: jest.fn() };
    const telegramOptions = { env: { TELEGRAM_CHAT_ID: '123' }, onMessage: jest.fn() };

    expect(service.startSms(smsOptions)).toBe(true);
    expect(service.startTelegram(telegramOptions)).toBe(true);
    service.stopAll();

    expect(smsPoller.start).toHaveBeenCalledWith(smsOptions);
    expect(telegramPoller.start).toHaveBeenCalledWith(telegramOptions);
    expect(smsPoller.stop).toHaveBeenCalledTimes(1);
    expect(telegramPoller.stop).toHaveBeenCalledTimes(1);
  });

  test('starts Telegram through a forked single-owner worker and relays messages to the app callback', () => {
    const worker = new EventEmitter();
    worker.connected = true;
    worker.send = jest.fn();
    worker.kill = jest.fn();
    const forkProcess = jest.fn(() => worker);
    const onMessage = jest.fn();
    const smsPoller = {
      start: jest.fn(() => true),
      stop: jest.fn(),
    };
    const telegramPoller = {
      start: jest.fn(() => {
        throw new Error('parent must not own getUpdates');
      }),
      stop: jest.fn(),
      _internals: {
        getTelegramConfig: jest.fn(() => ({ botToken: 'token', chatId: 123 })),
      },
    };
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const service = createInboundPollerService({
      smsPoller,
      telegramPoller,
      forkProcess,
      log: logger,
      telegramWorkerPath: 'telegram-worker.js',
      useTelegramWorker: true,
    });

    const started = service.startTelegram({
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: '123',
        SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\sideprofile',
        SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\sideprofile',
        TELEGRAM_POLLER_STATE_PATH: 'D:\\SquidRun\\sideprofile\\.squidrun\\runtime\\telegram-poller-state.json',
      },
      onMessage,
      pollIntervalMs: 5000,
      requestTimeoutMs: 25000,
      downloadMedia: false,
    });

    expect(started).toBe(true);
    expect(forkProcess).toHaveBeenCalledWith(
      'telegram-worker.js',
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          SQUIDRUN_TELEGRAM_POLLER_WORKER: '1',
          SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\sideprofile',
          SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\sideprofile',
          TELEGRAM_POLLER_STATE_PATH: 'D:\\SquidRun\\sideprofile\\.squidrun\\runtime\\telegram-poller-state.json',
        }),
      })
    );
    expect(telegramPoller.start).not.toHaveBeenCalled();
    expect(telegramPoller.stop).toHaveBeenCalledTimes(1);
    expect(worker.send).toHaveBeenCalledWith({
      type: 'start',
      options: expect.objectContaining({
        env: expect.objectContaining({
          SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\sideprofile',
          SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\sideprofile',
          TELEGRAM_POLLER_STATE_PATH: 'D:\\SquidRun\\sideprofile\\.squidrun\\runtime\\telegram-poller-state.json',
        }),
        pollIntervalMs: 5000,
        requestTimeoutMs: 25000,
        downloadMedia: false,
        keepAlive: true,
      }),
    });
    expect(service.getTelegramWorkerState()).toEqual({
      phase: 'spawned',
      ready: false,
      reason: null,
    });

    worker.emit('message', {
      type: 'starting',
      phase: 'standalone_lane_handoff',
    });
    expect(service.getTelegramWorkerState()).toEqual({
      phase: 'standalone_lane_handoff',
      ready: false,
      reason: null,
    });

    worker.emit('message', {
      type: 'starting',
      phase: 'poll_dispatch_lease',
    });
    expect(service.getTelegramWorkerState()).toEqual({
      phase: 'poll_dispatch_lease',
      ready: false,
      reason: null,
    });

    worker.emit('message', {
      type: 'started',
      started: true,
      reason: null,
    });
    expect(service.getTelegramWorkerState()).toEqual({
      phase: 'ready',
      ready: true,
      reason: null,
    });

    worker.emit('message', {
      type: 'message',
      payload: {
        text: 'hello',
        from: '@james',
        metadata: { updateId: 7 },
      },
    });

    expect(onMessage).toHaveBeenCalledWith('hello', '@james', { updateId: 7 });

    service.stopTelegram();
    expect(worker.send).toHaveBeenCalledWith({ type: 'shutdown' });
    expect(service.getTelegramWorkerState()).toEqual({
      phase: 'stopping',
      ready: false,
      reason: 'intentional_stop',
    });
    worker.emit('exit', 0, 'SIGTERM');
    expect(service.getTelegramWorkerState()).toEqual({
      phase: 'idle',
      ready: false,
      reason: 'intentional_stop',
    });
  });

  test('distinguishes bounded handoff failure from missing config and initial spawn acceptance', () => {
    const worker = new EventEmitter();
    worker.connected = true;
    worker.send = jest.fn();
    worker.kill = jest.fn();
    const forkProcess = jest.fn(() => worker);
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const telegramPoller = {
      stop: jest.fn(),
      _internals: {
        getTelegramConfig: jest.fn(() => ({ botToken: 'token', chatId: 123 })),
      },
    };
    const service = createInboundPollerService({
      smsPoller: { start: jest.fn(), stop: jest.fn() },
      telegramPoller,
      forkProcess,
      log: logger,
      telegramWorkerPath: 'telegram-worker.js',
      useTelegramWorker: true,
    });

    expect(service.startTelegram({
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: '123',
      },
    })).toBe(true);
    expect(service.getTelegramWorkerState()).toEqual({
      phase: 'spawned',
      ready: false,
      reason: null,
    });

    worker.emit('message', {
      type: 'starting',
      phase: 'standalone_lane_handoff',
    });
    worker.emit('message', {
      type: 'started',
      started: false,
      reason: 'standalone_lane_handoff_timeout',
    });

    expect(service.getTelegramWorkerState()).toEqual({
      phase: 'failed',
      ready: false,
      reason: 'standalone_lane_handoff_timeout',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Telegram',
      'Telegram poller worker did not start (standalone_lane_handoff_timeout)'
    );
    expect(service.getTelegramWorkerState().reason).not.toBe('missing_config');
  });

  test('retiring worker exit cannot overwrite replacement worker readiness', async () => {
    const workers = [new EventEmitter(), new EventEmitter()];
    for (const worker of workers) {
      worker.connected = true;
      worker.send = jest.fn();
      worker.kill = jest.fn();
    }
    const service = createInboundPollerService({
      smsPoller: { start: jest.fn(), stop: jest.fn() },
      telegramPoller: {
        stop: jest.fn(),
        _internals: {
          getTelegramConfig: jest.fn(() => ({ botToken: 'token', chatId: 123 })),
        },
      },
      forkProcess: jest.fn()
        .mockReturnValueOnce(workers[0])
        .mockReturnValueOnce(workers[1]),
      telegramWorkerPath: 'telegram-worker.js',
      useTelegramWorker: true,
    });
    const options = {
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: '123',
      },
    };

    expect(service.startTelegram(options)).toBe(true);
    workers[0].emit('message', { type: 'started', started: true });
    expect(service.getTelegramWorkerState().ready).toBe(true);

    // Replacement now goes through the SAFE path: stop, observe the exit, then
    // start. The old fire-and-forget stop-then-fork could have both children
    // alive at once, so it is refused outright.
    const stopping = service.stopTelegram({ graceMs: 50, killWaitMs: 50 });
    workers[0].emit('exit', 0, 'SIGTERM');
    await stopping;

    expect(service.startTelegram(options)).toBe(true);
    expect(service.getTelegramWorkerState()).toEqual({
      phase: 'spawned',
      ready: false,
      reason: null,
    });
    // A LATE stray exit from the retired worker must not clobber the
    // replacement's state — that is what the generation guard is for.
    workers[0].emit('exit', 0, 'SIGTERM');
    expect(service.getTelegramWorkerState()).toEqual({
      phase: 'spawned',
      ready: false,
      reason: null,
    });
  });

  test('uses electron-as-node fork options for packaged Telegram worker', () => {
    const worker = new EventEmitter();
    worker.connected = true;
    worker.send = jest.fn();
    worker.kill = jest.fn();
    const forkProcess = jest.fn(() => worker);
    const originalExecPath = process.execPath;
    const originalVersions = process.versions;
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      writable: true,
      value: 'D:\\SquidRun\\sideprofile\\versions\\0.1.34-test\\sr-electron.exe',
    });
    Object.defineProperty(process, 'versions', {
      configurable: true,
      value: {
        ...originalVersions,
        electron: '28.3.3',
      },
    });

    try {
      const service = createInboundPollerService({
        smsPoller: { start: jest.fn(), stop: jest.fn() },
        telegramPoller: {
          stop: jest.fn(),
          _internals: {
            getTelegramConfig: jest.fn(() => ({ botToken: 'token', chatId: REDACTED-CHAT-ID })),
          },
        },
        forkProcess,
        telegramWorkerPath: 'telegram-worker.js',
        useTelegramWorker: true,
      });

      expect(service.startTelegram({
        env: {
          TELEGRAM_BOT_TOKEN: 'token',
          TELEGRAM_CHAT_ID: 'REDACTED-CHAT-ID',
          SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\sideprofile',
          SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\sideprofile',
        },
      })).toBe(true);

      expect(forkProcess).toHaveBeenCalledWith(
        'telegram-worker.js',
        [],
        expect.objectContaining({
          execPath: 'D:\\SquidRun\\sideprofile\\versions\\0.1.34-test\\sr-electron.exe',
          env: expect.objectContaining({
            SQUIDRUN_TELEGRAM_POLLER_WORKER: '1',
            SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\sideprofile',
            SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\sideprofile',
            ELECTRON_RUN_AS_NODE: '1',
          }),
        })
      );
    } finally {
      Object.defineProperty(process, 'execPath', {
        configurable: true,
        writable: true,
        value: originalExecPath,
      });
      Object.defineProperty(process, 'versions', {
        configurable: true,
        value: originalVersions,
      });
    }
  });
});

describe('observed-exit worker replacement (Stage A)', () => {
  const { InboundPollerService } = require('../modules/main/inbound-poller-service');
  const silentLog = { info() {}, warn() {}, error() {} };

  function fakeWorker() {
    const handlers = {};
    return {
      killed: false,
      connected: true,
      send: jest.fn(),
      kill: jest.fn(function kill() { this.killed = true; }),
      once(event, fn) { (handlers[event] = handlers[event] || []).push(fn); return this; },
      on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); return this; },
      emit(event, ...args) { (handlers[event] || []).forEach((fn) => fn(...args)); },
    };
  }

  function serviceWithWorker(worker) {
    const svc = new InboundPollerService({ log: silentLog, useTelegramWorker: true });
    svc.telegramWorker = worker;
    return svc;
  }

  test('A GRACEFUL EXIT resolves as observed', async () => {
    const worker = fakeWorker();
    const svc = serviceWithWorker(worker);

    const pending = svc.stopTelegramWorkerAndWait({ graceMs: 50, killWaitMs: 50 });
    worker.emit('exit', 0, null);

    await expect(pending).resolves.toMatchObject({ ok: true, exited: true });
    expect(worker.send).toHaveBeenCalledWith({ type: 'shutdown' });
  });

  test('NO OBSERVED EXIT fails so the caller cannot fork a replacement', async () => {
    // An unobserved exit is indistinguishable from a live child. Two getUpdates
    // children on one cursor is the duplicate-delivery bug this prevents.
    jest.useFakeTimers();
    try {
      const worker = fakeWorker();
      const svc = serviceWithWorker(worker);

      let settled = null;
      const pending = svc.stopTelegramWorkerAndWait({ graceMs: 100, killWaitMs: 100 })
        .then((r) => { settled = r; });

      await jest.advanceTimersByTimeAsync(100);
      expect(worker.kill).toHaveBeenCalled();
      expect(settled).toBeNull();

      await jest.advanceTimersByTimeAsync(100);
      await pending;
      expect(settled).toMatchObject({ ok: false, exited: false, reason: 'exit_not_observed' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('A KILLED WORKER that then exits still resolves as observed', async () => {
    jest.useFakeTimers();
    try {
      const worker = fakeWorker();
      const svc = serviceWithWorker(worker);

      let settled = null;
      const pending = svc.stopTelegramWorkerAndWait({ graceMs: 50, killWaitMs: 500 })
        .then((r) => { settled = r; });

      await jest.advanceTimersByTimeAsync(50);
      worker.emit('exit', null, 'SIGTERM');
      await pending;

      expect(settled).toMatchObject({ ok: true, exited: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('CONCURRENT STOPS coalesce into one in-flight operation', async () => {
    const worker = fakeWorker();
    const svc = serviceWithWorker(worker);

    const a = svc.stopTelegramWorkerAndWait({ graceMs: 50, killWaitMs: 50 });
    const b = svc.stopTelegramWorkerAndWait({ graceMs: 50, killWaitMs: 50 });
    expect(a).toBe(b);

    worker.emit('exit', 0, null);
    await a;
  });

  test('A DIRECT START IS REFUSED while a stop is in flight', async () => {
    const worker = fakeWorker();
    const svc = serviceWithWorker(worker);

    const pending = svc.stopTelegramWorkerAndWait({ graceMs: 50, killWaitMs: 50 });
    const started = svc.startTelegram({ env: {}, onMessage: () => {} });

    expect(started).toMatchObject({ accepted: false, reason: 'stop_in_flight' });

    worker.emit('exit', 0, null);
    await pending;
  });

  test('WITH NO WORKER the stop resolves immediately as already exited', async () => {
    const svc = new InboundPollerService({ log: silentLog, useTelegramWorker: true });
    await expect(svc.stopTelegramWorkerAndWait()).resolves.toMatchObject({ ok: true, exited: true });
  });
});

describe('public lifecycle covers BOTH owner modes (Stage A, #172/#173)', () => {
  const { InboundPollerService } = require('../modules/main/inbound-poller-service');
  const silentLog = { info() {}, warn() {}, error() {} };

  test('IN-PROCESS mode stops through the same public method', async () => {
    // Routing restart at the worker-only seam regressed this mode entirely:
    // there is no worker to observe, and stopTelegramWorkerAndWait would have
    // reported "no worker" while the in-process poller kept running.
    const telegramPoller = { stop: jest.fn(), start: jest.fn() };
    const svc = new InboundPollerService({
      log: silentLog, useTelegramWorker: false, telegramPoller,
    });

    await expect(svc.stopTelegram()).resolves.toMatchObject({ ok: true, exited: true });
    expect(telegramPoller.stop).toHaveBeenCalledTimes(1);
  });

  test('A START IS REFUSED while a worker is already live', () => {
    // The old path fire-and-forget stopped a LIVE worker and forked at once.
    const svc = new InboundPollerService({ log: silentLog, useTelegramWorker: true });
    svc.telegramWorker = { send: jest.fn(), kill: jest.fn(), once() {}, on() {} };

    expect(svc.startTelegram({ env: {}, onMessage: () => {} }))
      .toMatchObject({ accepted: false, reason: 'worker_already_live' });
  });

  test('ONLY ONE kill is scheduled per stop', async () => {
    jest.useFakeTimers();
    try {
      const handlers = {};
      const worker = {
        killed: false, connected: true,
        send: jest.fn(),
        kill: jest.fn(function kill() { this.killed = true; }),
        once(e, fn) { (handlers[e] = handlers[e] || []).push(fn); return this; },
        on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); return this; },
        emit(e, ...a) { (handlers[e] || []).forEach((fn) => fn(...a)); },
      };
      const svc = new InboundPollerService({ log: silentLog, useTelegramWorker: true });
      svc.telegramWorker = worker;

      const pending = svc.stopTelegram({ graceMs: 100, killWaitMs: 100 });
      await jest.advanceTimersByTimeAsync(300);
      await pending;

      // The awaited path arms its own kill; stopTelegramWorker must not arm a
      // second one against the same child.
      expect(worker.kill).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('a TIMED-OUT stop must not fail open (Architect #175)', () => {
  const { InboundPollerService } = require('../modules/main/inbound-poller-service');
  const silentLog = { info() {}, warn() {}, error() {} };

  const makeWorker = () => {
    const handlers = {};
    return {
      killed: false, connected: true, send: jest.fn(),
      kill: jest.fn(function kill() { this.killed = true; }),
      on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); return this; },
      once(e, fn) { return this.on(e, fn); },
      removeListener(e, fn) {
        handlers[e] = (handlers[e] || []).filter((f) => f !== fn);
        return this;
      },
      emit(e, ...a) { (handlers[e] || []).slice().forEach((fn) => fn(...a)); },
      listenerCount(e) { return (handlers[e] || []).length; },
    };
  };

  test('TIMEOUT THEN A SECOND RESTART FORKS NOTHING until the late exit lands', async () => {
    jest.useFakeTimers();
    try {
      const forkProcess = jest.fn(() => makeWorker());
      const svc = new InboundPollerService({ log: silentLog, useTelegramWorker: true, forkProcess });
      const stale = makeWorker();
      svc.telegramWorker = stale;

      // The child ignores shutdown AND the kill — it never emits exit.
      const first = svc.stopTelegram({ graceMs: 50, killWaitMs: 50 });
      await jest.advanceTimersByTimeAsync(200);
      expect(await first).toMatchObject({ ok: false, reason: 'exit_not_observed' });

      // stopTelegramWorker already nulled this.telegramWorker and the latch has
      // cleared. Without a fence the service now believes nothing is running,
      // and this start forks a SECOND poller onto the same cursor.
      expect(svc.startTelegram({ env: {}, onMessage: () => {} }))
        .toMatchObject({ accepted: false, reason: 'retiring_worker_exit_unproven' });
      expect(forkProcess).not.toHaveBeenCalled();

      // A second stop must not answer "no_worker" either — that reads as proof.
      const second = svc.stopTelegram({ graceMs: 50, killWaitMs: 50 });
      await jest.advanceTimersByTimeAsync(200);
      expect(await second).toMatchObject({ ok: false, reason: 'exit_not_observed' });
      expect(forkProcess).not.toHaveBeenCalled();

      // Only the ACTUAL exit lowers the fence.
      stale.emit('exit', 0, 'SIGKILL');
      expect(svc.telegramRetiringWorker).toBe(null);
      svc.startTelegram({ env: {}, onMessage: () => {} });
      expect(forkProcess).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('THE FENCE IS IDENTITY-KEYED: another child exiting does not lower it', async () => {
    jest.useFakeTimers();
    try {
      const svc = new InboundPollerService({ log: silentLog, useTelegramWorker: true, forkProcess: jest.fn() });
      const stale = makeWorker();
      svc.telegramWorker = stale;
      const stopping = svc.stopTelegram({ graceMs: 50, killWaitMs: 50 });
      await jest.advanceTimersByTimeAsync(200);
      await stopping;

      // Give the SECOND child a stop of its own, so it too carries a fence
      // listener. The fence now names `second`; a late exit from the earlier
      // `stale` child must not lower it.
      const second = makeWorker();
      svc.telegramWorker = second;
      const secondStop = svc.stopTelegram({ graceMs: 50, killWaitMs: 50 });
      await jest.advanceTimersByTimeAsync(200);
      await secondStop;
      expect(svc.telegramRetiringWorker).toBe(second);

      stale.emit('exit', 0, 'SIGKILL');

      // Without the identity guard this clears the fence for a child that is
      // still unproven, and the next start forks straight over it.
      expect(svc.telegramRetiringWorker).toBe(second);
      expect(svc.startTelegram({ env: {}, onMessage: () => {} }))
        .toMatchObject({ accepted: false, reason: 'retiring_worker_exit_unproven' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('A TIMED-OUT ATTEMPT LEAVES NO exit LISTENER BEHIND', async () => {
    jest.useFakeTimers();
    try {
      const svc = new InboundPollerService({ log: silentLog, useTelegramWorker: true, forkProcess: jest.fn() });
      const stale = makeWorker();
      svc.telegramWorker = stale;

      for (let i = 0; i < 3; i += 1) {
        const p = svc.stopTelegram({ graceMs: 20, killWaitMs: 20 });
        await jest.advanceTimersByTimeAsync(100);
        await p;
      }

      // Exactly one listener survives: the fence-lowering one, which MUST
      // outlive each attempt. Three timed-out attempts must not stack three
      // settle listeners on top of it.
      expect(stale.listenerCount('exit')).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('A SYNCHRONOUS EXIT LEAVES NO ARMED TIMER AND NO KILL (#177)', async () => {
    jest.useFakeTimers();
    try {
      const svc = new InboundPollerService({ log: silentLog, useTelegramWorker: true, forkProcess: jest.fn() });
      const worker = makeWorker();
      // Exits the moment it is told to shut down, before the stop function has
      // finished running.
      worker.send = jest.fn(() => { worker.emit('exit', 0, null); });
      svc.telegramWorker = worker;

      const result = await svc.stopTelegram({ graceMs: 50, killWaitMs: 50 });

      expect(result).toMatchObject({ ok: true, exited: true });
      expect(worker.kill).not.toHaveBeenCalled();
      // A timer armed after settlement would fire into a slot that may already
      // hold the replacement child.
      expect(jest.getTimerCount()).toBe(0);
      expect(svc.telegramRetiringWorker).toBe(null);
    } finally {
      jest.useRealTimers();
    }
  });

  test('THE STOP LATCH IS CLEARED ONLY BY ITS OWNING PROMISE (#176)', async () => {
    jest.useFakeTimers();
    try {
      const svc = new InboundPollerService({ log: silentLog, useTelegramWorker: true, forkProcess: jest.fn() });
      const worker = makeWorker();
      svc.telegramWorker = worker;

      const owning = svc.stopTelegram({ graceMs: 50, killWaitMs: 50 });
      // A newer stop takes the latch before the first one settles.
      const newer = Promise.resolve({ ok: true, exited: true });
      svc.telegramStopInFlight = newer;
      await jest.advanceTimersByTimeAsync(200);
      await owning;

      // An unconditional clear would wipe the NEWER stop's latch, reopening the
      // start-during-stop race.
      expect(svc.telegramStopInFlight).toBe(newer);
    } finally {
      jest.useRealTimers();
    }
  });
});
