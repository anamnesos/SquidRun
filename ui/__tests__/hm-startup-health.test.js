const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SCHEDULED_PHASE_STALE_GRACE_MS,
  inspectLaneFreshness,
} = require('../scripts/hm-startup-health');

function writeState(tempDir, payload) {
  const filePath = path.join(tempDir, 'lane-state.json');
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

describe('hm-startup-health lane freshness', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-startup-health-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('keeps crypto trading supervisor healthy while idling before the scheduled next phase', () => {
    const filePath = writeState(tempDir, {
      lastProcessedAt: '2026-04-25T09:00:00.000Z',
      nextEvent: {
        key: 'crypto_consensus',
        scheduledAt: '2026-04-25T11:00:00.000Z',
      },
    });

    const lane = inspectLaneFreshness({
      key: 'crypto_trading_supervisor',
      filePath,
      enabled: true,
      staleAfterMs: 45 * 60 * 1000,
      extractTimestamp: (payload) => Date.parse(payload.lastProcessedAt),
      extractNextEventTimestamp: (payload) => Date.parse(payload.nextEvent?.scheduledAt),
      phaseGraceMs: SCHEDULED_PHASE_STALE_GRACE_MS,
      nowMs: Date.parse('2026-04-25T10:30:00.000Z'),
    });

    expect(lane).toEqual(expect.objectContaining({
      stale: false,
      reason: 'awaiting_scheduled_phase',
      nextEventAt: '2026-04-25T11:00:00.000Z',
    }));
    expect(lane.ageMinutes).toBe(90);
  });

  test('marks crypto trading supervisor stale after next phase time plus grace passes', () => {
    const filePath = writeState(tempDir, {
      lastProcessedAt: '2026-04-25T09:00:00.000Z',
      nextEvent: {
        key: 'crypto_consensus',
        scheduledAt: '2026-04-25T11:00:00.000Z',
      },
    });

    const lane = inspectLaneFreshness({
      key: 'crypto_trading_supervisor',
      filePath,
      enabled: true,
      staleAfterMs: 45 * 60 * 1000,
      extractTimestamp: (payload) => Date.parse(payload.lastProcessedAt),
      extractNextEventTimestamp: (payload) => Date.parse(payload.nextEvent?.scheduledAt),
      phaseGraceMs: SCHEDULED_PHASE_STALE_GRACE_MS,
      nowMs: Date.parse('2026-04-25T11:11:00.000Z'),
    });

    expect(lane).toEqual(expect.objectContaining({
      stale: true,
      reason: 'scheduled_phase_overdue',
      nextEventAt: '2026-04-25T11:00:00.000Z',
    }));
  });

  test('falls back to the legacy stale threshold when no next phase timestamp is exposed', () => {
    const filePath = writeState(tempDir, {
      lastProcessedAt: '2026-04-25T09:00:00.000Z',
    });

    const lane = inspectLaneFreshness({
      key: 'market_scanner',
      filePath,
      enabled: true,
      staleAfterMs: 45 * 60 * 1000,
      extractTimestamp: (payload) => Date.parse(payload.lastProcessedAt),
      extractNextEventTimestamp: (payload) => Date.parse(payload.nextEvent?.scheduledAt),
      phaseGraceMs: SCHEDULED_PHASE_STALE_GRACE_MS,
      nowMs: Date.parse('2026-04-25T09:46:00.000Z'),
    });

    expect(lane).toEqual(expect.objectContaining({
      stale: true,
      observedAt: '2026-04-25T09:00:00.000Z',
      staleAfterMinutes: 45,
    }));
    expect(lane.reason).toBeUndefined();
  });

  test('keeps paper trading automation healthy during a scheduled 6h phase gap', () => {
    const filePath = writeState(tempDir, {
      lastProcessedAt: '2026-04-25T09:00:00.000Z',
      nextEvent: {
        key: 'intraday_review',
        scheduledAt: '2026-04-25T15:00:00.000Z',
      },
    });
    const nowMs = Date.parse('2026-04-25T13:30:00.000Z');

    const phaseAwareLane = inspectLaneFreshness({
      key: 'paper_trading_automation',
      filePath,
      enabled: true,
      staleAfterMs: 60 * 60 * 1000,
      extractTimestamp: (payload) => Date.parse(payload.lastProcessedAt),
      extractNextEventTimestamp: (payload) => Date.parse(payload.nextEvent?.scheduledAt),
      phaseGraceMs: SCHEDULED_PHASE_STALE_GRACE_MS,
      nowMs,
    });
    const legacyLane = inspectLaneFreshness({
      key: 'paper_trading_automation',
      filePath,
      enabled: true,
      staleAfterMs: 60 * 60 * 1000,
      extractTimestamp: (payload) => Date.parse(payload.lastProcessedAt),
      nowMs,
    });

    expect(phaseAwareLane).toEqual(expect.objectContaining({
      stale: false,
      reason: 'awaiting_scheduled_phase',
      nextEventAt: '2026-04-25T15:00:00.000Z',
    }));
    expect(phaseAwareLane.ageMinutes).toBe(270);
    expect(legacyLane).toEqual(expect.objectContaining({
      stale: true,
      staleAfterMinutes: 60,
    }));
    expect(legacyLane.reason).toBeUndefined();
  });
});
