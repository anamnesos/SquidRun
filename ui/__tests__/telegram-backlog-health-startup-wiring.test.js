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
  test('A MISSING SNAPSHOT WITH A LIVE SPOOL DEGRADES — absence is never health', () => {
    // THE PRODUCTION CASE. A spool exists, so messages can be queued behind a
    // wedge, and a missing report is exactly the silence that cost 8.6 hours.
    const root = projectRoot();
    fs.mkdirSync(path.join(root, '.squidrun', 'runtime', 'telegram-inbound', 'main'), { recursive: true });

    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('degraded');
    expect(result.reasons).toContain('backlog_snapshot_missing');
  });

  test('A ROOT WITH NO TELEGRAM INGRESS AT ALL is genuinely ok, and only that case', () => {
    // The exemption is absence of the FEATURE, not absence of a report. It is
    // pinned alongside the case above so it can never be widened to cover a
    // configured-but-silent channel.
    const result = readTelegramBacklogHealth(projectRoot(), NOW);
    expect(result.ok).toBe(true);
    expect(result.reasons).toContain('no_telegram_ingress_configured');
  });

  test('AN UNPARSEABLE SNAPSHOT DEGRADES', () => {
    const root = projectRoot();
    const statePath = path.join(root, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(path.join(root, '.squidrun', 'runtime', 'telegram-inbound'), { recursive: true });
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
    fs.mkdirSync(path.join(root, '.squidrun', 'runtime', 'telegram-inbound'), { recursive: true });
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
        // The DURABLE input, since the reader recomputes age rather than
        // trusting whatever the producer asserted.
        oldestPendingReceivedAtMs: NOW - 45 * 60 * 1000,
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

describe('strict reader (Architect #60)', () => {
  test('AN ARRAY does not pass the routes shape check', () => {
    const root = projectRoot();
    const statePath = path.join(root, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(path.join(root, '.squidrun', 'runtime', 'telegram-inbound'), { recursive: true });
    // typeof [] === 'object', so this used to pass and iterate as zero routes.
    fs.writeFileSync(statePath, JSON.stringify({ routes: [] }), 'utf8');
    expect(readTelegramBacklogHealth(root, NOW).ok).toBe(false);
  });

  test('AN UNKNOWN SCHEMA VERSION is refused rather than scored', () => {
    const root = projectRoot();
    const statePath = path.join(root, '.squidrun', 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(path.join(root, '.squidrun', 'runtime', 'telegram-inbound'), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      schema: 'telegramBacklogHealth.v99', routes: { main: healthyRoute() },
    }), 'utf8');
    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join()).toMatch(/schema_unknown/);
  });

  test('A MALFORMED ROUTE ENTRY degrades instead of throwing or passing', () => {
    const root = projectRoot();
    writeSnapshot(root, { main: 'not an object' });
    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons.join()).toMatch(/route_entry_malformed/);
  });

  test('HEAD AGE IS RECOMPUTED against our clock, not taken from the producer', () => {
    // The producer asserted a comfortable 1s age an hour ago. Recomputing from
    // the durable received-at exposes the real 3-hour backlog.
    const root = projectRoot();
    writeSnapshot(root, {
      main: healthyRoute({
        pendingCount: 1,
        oldestPendingUpdateId: 808499317,
        oldestPendingAgeMs: 1000,
        oldestPendingReceivedAtMs: NOW - 3 * 60 * 60 * 1000,
      }),
    });
    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.severity).toBe('critical');
    expect(result.routes.main.headAgeMs).toBe(3 * 60 * 60 * 1000);
  });

  test('WITHOUT A DURABLE received-at the age is UNKNOWN, never inherited from the assertion', () => {
    const root = projectRoot();
    writeSnapshot(root, {
      main: healthyRoute({ pendingCount: 1, oldestPendingUpdateId: 1, oldestPendingAgeMs: 1000 }),
    });
    const result = readTelegramBacklogHealth(root, NOW);
    expect(result.ok).toBe(false);
    expect(result.routes.main.reasons.join()).toMatch(/oldest_pending_age_unknown/);
  });

  test('A FUTURE observedAtMs is treated as stale — an unreconcilable clock is not freshness', () => {
    const root = projectRoot();
    writeSnapshot(root, { main: healthyRoute({ observedAtMs: NOW + 10 * 60 * 1000 }) });
    expect(readTelegramBacklogHealth(root, NOW).ok).toBe(false);
  });
});
