'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');
const { getMarketCalendar } = require('./data-ingestion');

const MARKET_TIME_ZONE = 'America/Los_Angeles';
const CALENDAR_SOURCE_TIME_ZONE = 'America/New_York';
const DEFAULT_SCHEDULE_PREFIX = 'trading-';
const DEFAULT_CRYPTO_INTERVAL_HOURS = 6;
const DEFAULT_PHASES = Object.freeze([
  { key: 'premarket_wake', label: 'Pre-market wake', offsetMinutes: -60 },
  { key: 'pre_open_consensus', label: 'Consensus round', offsetMinutes: -5 },
  { key: 'market_open_execute', label: 'Market open execute', offsetMinutes: 0 },
  { key: 'close_wake', label: 'Close wake', anchor: 'close', offsetMinutes: -30 },
  { key: 'market_close_review', label: 'Market close review', anchor: 'close', offsetMinutes: 0 },
]);
const DEFAULT_CRYPTO_PHASES = Object.freeze([
  { key: 'crypto_consensus', label: 'Crypto consensus round' },
]);

function resolveCalendarCachePath() {
  return resolveCoordPath(path.join('runtime', 'trading-calendar-cache.json'), { forWrite: true });
}

function resolveWakeSignalPath() {
  return resolveCoordPath(path.join('runtime', 'supervisor-wake.signal'), { forWrite: true });
}

function toDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

function toDateKeyInZone(value = new Date(), timeZone = MARKET_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(value instanceof Date ? value : new Date(value));
}

function resolveCryptoIntervalHours(value, fallback = DEFAULT_CRYPTO_INTERVAL_HOURS) {
  const numeric = Number.parseInt(String(value || fallback), 10);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(4, Math.min(6, numeric));
}

function normalizeCalendarEntry(entry = {}) {
  return {
    date: String(entry.date || '').trim(),
    open: String(entry.open || '').trim(),
    close: String(entry.close || '').trim(),
    sessionOpenEt: String(entry.session_open || entry.sessionOpen || '').trim(),
    sessionCloseEt: String(entry.session_close || entry.sessionClose || '').trim(),
    raw: entry,
  };
}

function readCalendarCache(cachePath = resolveCalendarCachePath()) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return {
      refreshedAt: null,
      days: {},
    };
  }
}

function writeCalendarCache(cache, cachePath = resolveCalendarCachePath()) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

function getTimeParts(timeString = '') {
  const match = String(timeString || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid time string: ${timeString}`);
  return {
    hour: Number.parseInt(match[1], 10),
    minute: Number.parseInt(match[2], 10),
  };
}

function getDateParts(dateString = '') {
  const match = String(dateString || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date string: ${dateString}`);
  return {
    year: Number.parseInt(match[1], 10),
    month: Number.parseInt(match[2], 10),
    day: Number.parseInt(match[3], 10),
  };
}

function getFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function partsFromFormatter(formatter, date) {
  const lookup = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number.parseInt(lookup.year, 10),
    month: Number.parseInt(lookup.month, 10),
    day: Number.parseInt(lookup.day, 10),
    hour: Number.parseInt(lookup.hour, 10),
    minute: Number.parseInt(lookup.minute, 10),
    second: Number.parseInt(lookup.second, 10),
  };
}

function zonedDateTimeToUtc(dateString, timeString, timeZone) {
  const dateParts = getDateParts(dateString);
  const timeParts = getTimeParts(timeString);
  let guess = Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, timeParts.hour, timeParts.minute, 0);
  const formatter = getFormatter(timeZone);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsFromFormatter(formatter, new Date(guess));
    const desiredUtc = Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, timeParts.hour, timeParts.minute, 0);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const delta = actualUtc - desiredUtc;
    if (delta === 0) break;
    guess -= delta;
  }

  return new Date(guess);
}

function formatTimeInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function padTimePart(value) {
  return String(value).padStart(2, '0');
}

function buildTradingDaySchedule(calendarEntry, options = {}) {
  const entry = normalizeCalendarEntry(calendarEntry);
  if (!entry.date || !entry.open || !entry.close) {
    throw new Error('calendarEntry must include date, open, and close');
  }

  const sourceTimeZone = options.sourceTimeZone || CALENDAR_SOURCE_TIME_ZONE;
  const displayTimeZone = options.displayTimeZone || MARKET_TIME_ZONE;
  const phases = Array.isArray(options.phases) && options.phases.length > 0
    ? options.phases
    : DEFAULT_PHASES;

  const marketOpenAt = zonedDateTimeToUtc(entry.date, entry.open, sourceTimeZone);
  const marketCloseAt = zonedDateTimeToUtc(entry.date, entry.close, sourceTimeZone);

  const schedule = phases.map((phase) => {
    const anchorDate = phase.anchor === 'close' ? marketCloseAt : marketOpenAt;
    const scheduledAt = new Date(anchorDate.getTime() + (Number(phase.offsetMinutes || 0) * 60 * 1000));
    return {
      key: phase.key,
      label: phase.label,
      marketDate: entry.date,
      scheduledAt: scheduledAt.toISOString(),
      scheduledTimeLocal: formatTimeInZone(scheduledAt, displayTimeZone),
      displayTimeZone,
    };
  });

  return {
    marketDate: entry.date,
    marketOpenEt: entry.open,
    marketCloseEt: entry.close,
    marketOpenAt: marketOpenAt.toISOString(),
    marketCloseAt: marketCloseAt.toISOString(),
    displayTimeZone,
    schedule,
    raw: entry.raw,
  };
}

async function refreshTradingCalendar(options = {}) {
  const cachePath = options.cachePath || resolveCalendarCachePath();
  const startDate = toDateKey(options.start || new Date());
  const endDate = toDateKey(options.end || new Date(Date.now() + (14 * 24 * 60 * 60 * 1000)));
  const entries = await getMarketCalendar({
    ...options,
    start: startDate,
    end: endDate,
  });

  const cache = readCalendarCache(cachePath);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeCalendarEntry(entry);
    if (normalized.date) {
      cache.days[normalized.date] = normalized;
    }
  }
  cache.refreshedAt = new Date().toISOString();
  writeCalendarCache(cache, cachePath);
  return cache;
}

async function getCalendarDay(date, options = {}) {
  const cachePath = options.cachePath || resolveCalendarCachePath();
  let cache = readCalendarCache(cachePath);
  const key = toDateKey(date);
  if (!cache.days[key]) {
    cache = await refreshTradingCalendar({
      ...options,
      start: key,
      end: key,
      cachePath,
    });
  }
  return cache.days[key] || null;
}

async function isTradingDay(date, options = {}) {
  const entry = await getCalendarDay(date, options);
  return Boolean(entry);
}

async function getNextWakeEvent(referenceDate = new Date(), options = {}) {
  const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  for (let offset = 0; offset < 10; offset += 1) {
    const candidateDate = new Date(now.getTime() + (offset * 24 * 60 * 60 * 1000));
    const calendarDay = await getCalendarDay(candidateDate, options);
    if (!calendarDay) continue;

    const tradingDay = buildTradingDaySchedule(calendarDay, options);
    const nextEvent = tradingDay.schedule.find((event) => new Date(event.scheduledAt).getTime() > now.getTime());
    if (nextEvent) {
      return {
        ...nextEvent,
        tradingDay,
      };
    }
  }
  return null;
}

function buildCryptoDailySchedule(referenceDate = new Date(), options = {}) {
  const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  const displayTimeZone = options.displayTimeZone || MARKET_TIME_ZONE;
  const intervalHours = resolveCryptoIntervalHours(options.intervalHours);
  const phases = Array.isArray(options.phases) && options.phases.length > 0
    ? options.phases
    : DEFAULT_CRYPTO_PHASES;
  const dateKey = toDateKeyInZone(now, displayTimeZone);
  const schedule = [];

  for (let hour = 0; hour < 24; hour += intervalHours) {
    const scheduledAt = zonedDateTimeToUtc(dateKey, `${padTimePart(hour)}:00`, displayTimeZone);
    for (const phase of phases) {
      schedule.push({
        key: phase.key,
        label: phase.label,
        marketDate: dateKey,
        scheduledAt: scheduledAt.toISOString(),
        scheduledTimeLocal: formatTimeInZone(scheduledAt, displayTimeZone),
        displayTimeZone,
        windowKey: scheduledAt.toISOString(),
      });
    }
  }

  return {
    marketDate: dateKey,
    intervalHours,
    displayTimeZone,
    schedule,
  };
}

async function getNextCryptoWakeEvent(referenceDate = new Date(), options = {}) {
  const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  for (let offset = 0; offset < 3; offset += 1) {
    const candidateDate = new Date(now.getTime() + (offset * 24 * 60 * 60 * 1000));
    const cryptoDay = buildCryptoDailySchedule(candidateDate, options);
    const nextEvent = cryptoDay.schedule.find((event) => new Date(event.scheduledAt).getTime() > now.getTime());
    if (nextEvent) {
      return {
        ...nextEvent,
        tradingDay: cryptoDay,
      };
    }
  }
  return null;
}

function writeWakeSignal(event, wakeSignalPath = resolveWakeSignalPath()) {
  fs.mkdirSync(path.dirname(wakeSignalPath), { recursive: true });
  fs.writeFileSync(wakeSignalPath, JSON.stringify({
    type: 'trading_wake',
    createdAt: new Date().toISOString(),
    event,
  }, null, 2));
  return wakeSignalPath;
}

async function syncSchedulesForNextTradingDay(scheduler, options = {}) {
  if (!scheduler || typeof scheduler.listSchedules !== 'function') {
    throw new Error('scheduler with listSchedules/addSchedule/updateSchedule/deleteSchedule is required');
  }

  const nextEvent = await getNextWakeEvent(options.referenceDate || new Date(), options);
  if (!nextEvent) {
    return {
      ok: false,
      reason: 'no_trading_day_found',
    };
  }

  const tradingDay = nextEvent.tradingDay;
  const prefix = String(options.schedulePrefix || DEFAULT_SCHEDULE_PREFIX);
  const existing = scheduler.listSchedules().filter((schedule) => String(schedule.name || '').startsWith(prefix));
  const desiredKeys = new Set(tradingDay.schedule.map((event) => event.key));

  for (const event of tradingDay.schedule) {
    const name = `${prefix}${event.key}`;
    const existingSchedule = existing.find((schedule) => schedule.name === name);
    const payload = {
      name,
      type: 'once',
      runAt: event.scheduledAt,
      timeZone: event.displayTimeZone,
      input: `[TRADING:${event.key}] ${event.label} for ${event.marketDate}`,
      active: true,
    };

    if (existingSchedule) {
      scheduler.updateSchedule(existingSchedule.id, payload);
    } else {
      scheduler.addSchedule(payload);
    }
  }

  for (const schedule of existing) {
    const key = String(schedule.name || '').slice(prefix.length);
    if (!desiredKeys.has(key)) {
      scheduler.deleteSchedule(schedule.id);
    }
  }

  return {
    ok: true,
    marketDate: tradingDay.marketDate,
    phases: tradingDay.schedule,
  };
}

module.exports = {
  MARKET_TIME_ZONE,
  CALENDAR_SOURCE_TIME_ZONE,
  DEFAULT_CRYPTO_INTERVAL_HOURS,
  DEFAULT_PHASES,
  DEFAULT_CRYPTO_PHASES,
  resolveCalendarCachePath,
  resolveWakeSignalPath,
  normalizeCalendarEntry,
  zonedDateTimeToUtc,
  buildTradingDaySchedule,
  buildCryptoDailySchedule,
  refreshTradingCalendar,
  getCalendarDay,
  isTradingDay,
  getNextWakeEvent,
  getNextCryptoWakeEvent,
  writeWakeSignal,
  syncSchedulesForNextTradingDay,
};
