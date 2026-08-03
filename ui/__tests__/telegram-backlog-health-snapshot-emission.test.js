/**
 * END-TO-END: the EMITTED snapshot must itself be non-OK.
 *
 * Architect #60 caught the previous wiring degrading only the wrapper — stderr
 * and an exit code — while the structured status the tooling publishes still
 * said OK, score 100, no warning. James does not read stderr or exit codes; he
 * reads the score. That is the incident's own failure shape reproduced inside
 * the fix for it: the knowledge existed and never reached the surface.
 *
 * So these tests assert on `buildHealthStatus` output — the thing that is
 * serialized into JSON and markdown — and NOT on the reader returning a nice
 * object. The reader can be perfect while the published number stays green.
 */
const { buildHealthStatus } = require('../scripts/hm-health-snapshot');

function baseSnapshot(overrides = {}) {
  // A snapshot that is otherwise entirely healthy, so any score movement is
  // attributable to the backlog alone.
  return {
    tests: { jestList: { ok: true }, testFileCount: 12 },
    modules: { keyModules: {} },
    databases: {},
    bridge: {},
    memoryConsistency: { status: 'synced', synced: true },
    systemCapabilities: {},
    theTellShadowRunner: {},
    telegramPoller: { status: 'fresh', wedged: false },
    supervisor: {},
    telegramIngressBacklog: { ok: true, severity: 'ok', reasons: [], routes: {} },
    ...overrides,
  };
}

function statusFor(backlog) {
  return buildHealthStatus(baseSnapshot({ telegramIngressBacklog: backlog }));
}

describe('the published score carries the backlog', () => {
  test('A CLEAN BACKLOG leaves a perfect score perfect', () => {
    const status = statusFor({ ok: true, severity: 'ok', reasons: [], routes: {} });
    expect(status.score).toBe(100);
    expect(status.warnings.join()).not.toMatch(/telegram_ingress_backlog/);
  });

  test('THE EXACT S491 STATE drops the EMITTED score below 100 and warns', () => {
    // Six messages, 8.6 hours, unprovable pane - and a genuinely fresh poller,
    // which is what made the old surface read 100/100.
    const status = statusFor({
      ok: false,
      severity: 'critical',
      reasons: ['main:proof_unattainable:unprovable_pane:runtime_never_produced_proof'],
      routes: {},
    });

    expect(status.score).toBeLessThan(100);
    expect(status.warnings.join()).toMatch(/telegram_ingress_backlog_critical/);
    expect(status.penalties.some((p) => p.code === 'telegram_ingress_backlog_critical')).toBe(true);
  });

  test('A MISSING SNAPSHOT drops the EMITTED score below 100', () => {
    const status = statusFor({
      ok: false, severity: 'degraded', reasons: ['backlog_snapshot_missing'], routes: {},
    });
    expect(status.score).toBeLessThan(100);
    expect(status.warnings.join()).toMatch(/backlog_snapshot_missing/);
  });

  test('A STALE SNAPSHOT drops the EMITTED score below 100', () => {
    const status = statusFor({
      ok: false, severity: 'degraded', reasons: ['main:backlog_snapshot_stale:main'], routes: {},
    });
    expect(status.score).toBeLessThan(100);
    expect(status.warnings.join()).toMatch(/backlog_snapshot_stale/);
  });

  test('NO BACKLOG SECTION AT ALL is penalised — a run that never asked is not a pass', () => {
    const snapshot = baseSnapshot();
    delete snapshot.telegramIngressBacklog;
    const status = buildHealthStatus(snapshot);

    expect(status.score).toBeLessThan(100);
    expect(status.warnings).toContain('telegram_ingress_backlog_unreported');
  });

  test.each([
    ['null', null],
    ['a string', 'ok'],
    ['an unrecognised severity', { severity: 'probably_fine', reasons: [] }],
  ])('A BACKLOG SECTION THAT IS %s cannot score clean', (_label, backlog) => {
    const status = statusFor(backlog);
    expect(status.score).toBeLessThan(100);
  });

  test('A FRESH POLLER CANNOT OFFSET a wedged backlog in the published status', () => {
    // Both signals present. The poller is fine; the channel is mute. The
    // published score must reflect the mute channel.
    const status = buildHealthStatus(baseSnapshot({
      telegramPoller: { status: 'fresh', wedged: false },
      telegramIngressBacklog: { ok: false, severity: 'critical', reasons: ['main:wedged'], routes: {} },
    }));
    expect(status.score).toBeLessThan(100);
    expect(String(status.level || status.label || '').toLowerCase()).not.toBe('ok');
  });

  test('A CRITICAL BACKLOG OUTWEIGHS a wedged poller, because undelivered beats unreceived', () => {
    const wedgedPoller = buildHealthStatus(baseSnapshot({
      telegramPoller: { status: 'stale', wedged: true },
    }));
    const wedgedBacklog = statusFor({ ok: false, severity: 'critical', reasons: ['x'], routes: {} });
    expect(wedgedBacklog.score).toBeLessThan(wedgedPoller.score);
  });
});
