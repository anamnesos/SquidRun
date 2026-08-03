/**
 * The production health surface must SEE the Telegram backlog.
 *
 * Every test here is a state that scored 100/100 on 2026-08-03 while six of
 * James's messages sat undelivered. The bias throughout is fail-safe: a check
 * that cannot read the backlog must degrade, never pass. "No news is good
 * news" is the exact reasoning that produced the false green.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readTelegramBacklogHealth } = require('../scripts/hm-startup-health');

const tempRoots = [];
function projectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-health-wire-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

const NOW = 1_785_780_000_000;

function writeSnapshot(root, routes, updatedAtMs = NOW) {
  const statePath = path.join(root, '.squidrun', 'runtime', 'telegram-backlog-health.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    schema: 'telegramBacklogHealth.v0', updatedAtMs, routes,
  }), 'utf8');
  return statePath;
}

function healthyRoute(overrides = {}) {
  return {
    pendingCount: 0,
    oldestPendingUpdateId: null,
    oldestPendingAgeMs: null,
    oldestPendingAgeUnknown: false,
    blockedUpdateId: null,
    blockedReason: null,
    proofUnattainable: false,
    attemptedCount: 0,
    lastRetirementAtMs: NOW - 1000,
    observedAtMs: NOW,
    ...overrides,
  };
}

describe('fail-safe reads', () => {
  test('A MISSING SNAPSHOT DEGRADES — absence is never health', () => {
    const result = readTelegramBacklogHealth(projectRoot(), NOW);
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('degraded');
    expect(result.reasons).toContain('backlog_snapshot_missing');
  });

  test('AN UNPARSEABLE SNAPSHOT DEGRADES', () => {
    const root = projectRoot();
    const statePath = path.join(root, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, 'not json at all', 'utf8');

    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join()).toMatch(/backlog_snapshot_malformed/);
  });

  test.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['an object with no routes', '{"schema":"x"}'],
    ['routes of the wrong type', '{"routes":"nope"}'],
  ])('A SNAPSHOT SHAPED WRONG (%s) DEGRADES', (_label, body) => {
    const root = projectRoot();
    const statePath = path.join(root, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, body, 'utf8');

    expect(readTelegramBacklogHealth(root, NOW).ok).toBe(false);
  });

  test('A SNAPSHOT WITH NO ROUTES DEGRADES — a reporter with nothing to say is not a pass', () => {
    const root = projectRoot();
    writeSnapshot(root, {});
    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('backlog_snapshot_has_no_routes');
  });

  test('A STALE SNAPSHOT DEGRADES even when its contents look perfect', () => {
    // The reporter died an hour ago. Its last words were good news, and that
    // is precisely why it must not still be believed.
    const root = projectRoot();
    writeSnapshot(root, { main: healthyRoute({ observedAtMs: NOW - 60 * 60 * 1000 }) });

    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join()).toMatch(/backlog_snapshot_stale:main/);
  });

  test('A ROUTE WITH NO observedAtMs AT ALL is treated as stale', () => {
    const root = projectRoot();
    const route = healthyRoute();
    delete route.observedAtMs;
    writeSnapshot(root, { main: route });

    expect(readTelegramBacklogHealth(root, NOW).ok).toBe(false);
  });
});

describe('scoring reaches the surface', () => {
  test('A FRESH, EMPTY QUEUE is the only way to pass', () => {
    const root = projectRoot();
    writeSnapshot(root, { main: healthyRoute() });

    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.ok).toBe(true);
    expect(result.severity).toBe('ok');
  });

  test('THE EXACT S491 STATE reaches CRITICAL', () => {
    const root = projectRoot();
    writeSnapshot(root, {
      main: healthyRoute({
        pendingCount: 6,
        oldestPendingUpdateId: 808499316,
        oldestPendingAgeMs: 8.6 * 60 * 60 * 1000,
        blockedUpdateId: 808499316,
        blockedReason: 'unprovable_pane:runtime_never_produced_proof',
        proofUnattainable: true,
      }),
    });

    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.severity).toBe('critical');
    expect(result.ok).toBe(false);
    expect(result.reasons.join()).toMatch(/main:proof_unattainable/);
  });

  test('THE WORST ROUTE DECIDES the overall verdict', () => {
    const root = projectRoot();
    writeSnapshot(root, {
      sideprofile: healthyRoute(),
      main: healthyRoute({
        pendingCount: 3,
        oldestPendingUpdateId: 808499317,
        oldestPendingAgeMs: 45 * 60 * 1000,
      }),
    });

    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.severity).toBe('critical');
    expect(result.routes.sideprofile.severity).toBe('ok');
    expect(result.routes.main.severity).toBe('critical');
  });

  test('EVERY REASON IS ROUTE-QUALIFIED so an operator knows which channel is mute', () => {
    const root = projectRoot();
    writeSnapshot(root, {
      main: healthyRoute({
        pendingCount: 2, oldestPendingUpdateId: 1, oldestPendingAgeMs: 20 * 60 * 1000,
      }),
    });

    for (const reason of readTelegramBacklogHealth(root, NOW).reasons) {
      expect(reason.startsWith('main:')).toBe(true);
    }
  });

  test('A CUSTOM statePath is honoured, so the check is testable without a project tree', () => {
    const root = projectRoot();
    const statePath = path.join(root, 'elsewhere.json');
    fs.writeFileSync(statePath, JSON.stringify({ routes: { main: healthyRoute() } }), 'utf8');

    expect(readTelegramBacklogHealth(root, NOW, { statePath }).ok).toBe(true);
  });
});
