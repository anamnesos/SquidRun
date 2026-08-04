/**
 * v7 §3 PHASE L — THE MODE IS FROZEN AT STARTUP, PROVED DYNAMICALLY.
 *
 * =====================================================================
 * WHY THIS IS ITS OWN SUITE
 * =====================================================================
 * Two reasons, and both matter.
 *
 * The proof needs a REAL `SquidRunApp`: the freeze is a property of the app's
 * startup sequence, and a source-string assertion about where
 * `captureTelegramActivationMode()` sits in `init()` proves ordering, not
 * behaviour. Architect #146 asked for the behavioural half — load a mode, run
 * the capture, mutate settings underneath, and show the generation does not
 * move.
 *
 * And it cannot live in `squidrun-app.test.js`. That file carries the fifteen
 * deliberate Telegram compatibility reds from Step 2A, so staging it fails the
 * pre-commit Jest gate — which runs every staged test file in full and is
 * right to. Adding an exception to the gate for a file we know fails would be
 * exactly the shaped check this lane keeps refusing. A separate suite keeps the
 * gate honest and the reds untouched.
 *
 * `squidrun-app.js` needs only an Electron mock to load, so the harness is
 * small. No live state: temp spool directories, stubbed instance methods, and
 * nothing reaches a pane, a database or Telegram.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

jest.mock('electron', () => ({
  app: {
    getPath: () => require('node:os').tmpdir(),
    getName: () => 'squidrun',
    setAppUserModelId: () => {},
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
  },
  BrowserWindow: class { static getAllWindows() { return []; } },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
  shell: {},
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  Tray: class {},
  nativeImage: { createFromPath: () => ({}) },
  screen: {},
  session: {},
  globalShortcut: { register: () => {}, unregisterAll: () => {} },
  powerMonitor: { on: () => {} },
  clipboard: {},
}));
jest.mock('../modules/logger', () => ({
  info() {}, warn() {}, error() {}, debug() {},
}));

const SquidRunApp = require('../modules/main/squidrun-app');
const queue = require('../modules/telegram-inbound-durable-queue');
const spool = require('../modules/main/telegram-ingress-spool');
const { LEGACY_SETTLEMENT } = require('../modules/main/telegram-activation-mode');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-freeze-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

const CHAT = 4242;

function makeApp(configuredMode) {
  const currentSettings = {};
  if (configuredMode !== undefined) currentSettings.telegramTransportActivationMode = configuredMode;
  const ctx = { currentSettings, mainWindow: null };
  const managers = {
    settings: { loadSettings: () => { throw new Error('the capture must not consult a second authority'); } },
    activity: {}, usage: {}, cliIdentity: {}, firmwareManager: {},
  };
  const app = new SquidRunApp(ctx, managers);
  return { app, ctx };
}

/** One unstamped legacy record, exactly as the live twelve were written. */
function seedLegacy(base, updateId) {
  const resolved = spool.resolveSpoolDir(base, 'main');
  expect(resolved.ok).toBe(true);
  expect(queue.append(resolved.dir, {
    updateId,
    text: `body ${updateId}`,
    from: 'james',
    chatId: CHAT,
    messageId: updateId * 10,
    routeKey: 'main',
    profile: 'main',
    targetProfile: 'main',
    targetWindow: 'main',
    targetSession: 'session-at-append',
  }).ok).toBe(true);
  return resolved.dir;
}

/**
 * Stub only the seams that would reach real infrastructure. The activation
 * wiring itself is left ALONE — it is the thing under test.
 */
function stubAppSeams(app, { deliver } = {}) {
  app.resolveTelegramInboundRoute = () => ({ ok: true, profile: 'main', windowKey: 'main' });
  app.getWindowSessionScopeId = () => 'session-now';
  app.resolveTelegramPaneRuntime = () => 'codex';
  app.getTelegramReceiptRuntimeActivity = () => ({ receiptsEverProduced: 5, lastReceiptAtMs: Date.now() });
  app.findTelegramDeliveryReceipt = async () => null;
  app.deliverTelegramInboundJob = deliver || (async () => {
    throw new Error('deliver must not be reached for a held record');
  });
  app.buildTelegramInboundJob = (job) => job;
}

describe('the freeze is a property of the generation, not of the last save', () => {
  test('a settings mutation AFTER the capture does not move this generation', () => {
    const { app, ctx } = makeApp(LEGACY_SETTLEMENT);

    // The init step, run exactly where init runs it.
    app.captureTelegramActivationMode();

    // ...and now something saves settings mid-session, before any drain has
    // asked. Lazy capture at first ask would let this decide the operating
    // state of a generation that already started.
    ctx.currentSettings.telegramTransportActivationMode = 'decision_scheduling';

    expect(app.getTelegramActivationModeSetting()).toBe(LEGACY_SETTLEMENT);
    // Re-capturing is a no-op, not a back door to the mutation the first one
    // refused.
    app.captureTelegramActivationMode();
    expect(app.getTelegramActivationModeSetting()).toBe(LEGACY_SETTLEMENT);
  });

  test('an UNSET mode freezes as unset, and a later save does not fix this generation', () => {
    const { app, ctx } = makeApp(undefined);

    app.captureTelegramActivationMode();
    ctx.currentSettings.telegramTransportActivationMode = LEGACY_SETTLEMENT;

    // Fails closed for the whole generation. The operator's save takes effect
    // on the next boot, which is the only point at which "this generation
    // settled legacy" can still be one coherent fact.
    expect(app.getTelegramActivationModeSetting()).toBe(null);
  });

  test('WITHOUT the capture the getter throws rather than guessing', () => {
    const { app } = makeApp(LEGACY_SETTLEMENT);

    // A getter that lazily read here would be indistinguishable from a real
    // install whose operator has not configured the mode, and the drain would
    // then report the wrong defect entirely.
    expect(() => app.getTelegramActivationModeSetting()).toThrow(/never frozen at startup/);
  });

  test('the capture consults ONE authority and never falls back to a second snapshot', () => {
    // `managers.settings.loadSettings` throws if called. An earlier draft fell
    // back to it when the field was absent — two mutable snapshots answering
    // one question, with the fallback firing in exactly the case that matters.
    const { app } = makeApp(undefined);

    expect(() => app.captureTelegramActivationMode()).not.toThrow();
    expect(app.getTelegramActivationModeSetting()).toBe(null);
  });
});

describe('the REAL drain coordinator operates from the frozen value', () => {
  test('a good freeze survives a later save: the drain does not hold on the mode', async () => {
    const { app, ctx } = makeApp(LEGACY_SETTLEMENT);
    app.captureTelegramActivationMode();
    stubAppSeams(app);
    const base = tempRoot();
    const dir = seedLegacy(base, 980);

    // Something saves a mode this build cannot operate in, mid-session.
    ctx.currentSettings.telegramTransportActivationMode = 'decision_scheduling';

    const coordinator = app.getTelegramDrainCoordinator();
    const res = await coordinator.drainOnce(dir, 'main');

    // It may well hold further down — this record has no claim store behind it
    // — but it must NOT hold on the activation mode, because this generation
    // froze a good one before that save happened.
    expect(res.stoppedAt?.reason || '').not.toMatch(/^activation_mode_unhealthy/);
    expect(res.backlog.activationMode).toBe(LEGACY_SETTLEMENT);
    expect(res.backlog.activationModeHealthy).toBe(true);
  });

  test('a BAD freeze is not rescued by a later save: the drain holds on the mode', async () => {
    // The load-bearing direction. If `getTelegramDrainCoordinator` dropped the
    // activation callback, or wired it to live settings instead of the frozen
    // getter, this drain would see a perfectly good `legacy_settlement` and
    // proceed — so this is the assertion that actually observes the wiring
    // rather than the app's own getter (Architect #161).
    const { app, ctx } = makeApp(undefined);
    app.captureTelegramActivationMode();
    stubAppSeams(app);
    const base = tempRoot();
    const dir = seedLegacy(base, 981);

    ctx.currentSettings.telegramTransportActivationMode = LEGACY_SETTLEMENT;

    const coordinator = app.getTelegramDrainCoordinator();
    const res = await coordinator.drainOnce(dir, 'main');

    expect(res.stoppedAt).toMatchObject({
      updateId: 981,
      reason: 'activation_mode_unhealthy:activation_mode_missing',
      resolutionRequired: true,
    });
    // Nothing moved, and the published snapshot says why.
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([981]);
    expect(res.backlog).toMatchObject({
      activationMode: null,
      activationModeHealthy: false,
      activationModeReason: 'activation_mode_missing',
    });
  });

  test('a coordinator built WITHOUT the startup capture wedges instead of guessing', async () => {
    // No `captureTelegramActivationMode()` at all: the getter throws, the drain
    // turns that into a named hold, and nothing is delivered on an assumption.
    const { app } = makeApp(LEGACY_SETTLEMENT);
    stubAppSeams(app);
    const base = tempRoot();
    const dir = seedLegacy(base, 982);

    const coordinator = app.getTelegramDrainCoordinator();
    const res = await coordinator.drainOnce(dir, 'main');

    expect(res.stoppedAt.reason).toBe(
      'activation_mode_unhealthy:activation_mode_threw:telegram activation mode was never frozen at startup'
    );
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([982]);
  });
});
