#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  main,
  normalizeProjectRoot,
} = require('./hm-health-snapshot');
const { DEFAULT_PROFILE, normalizeProfileName } = require('../profile');

const VALUE_OPTIONS = new Set([
  '--output',
  '--profile',
  '--telegram-poller-stale-threshold-ms',
]);

function hasFormatFlag(argv = []) {
  return argv.some((arg) => arg === '--json' || arg === '--markdown');
}

function hasHelpFlag(argv = []) {
  return argv.some((arg) => arg === '--help' || arg === '-h');
}

function getOptionValue(argv = [], name) {
  const inlinePrefix = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token.startsWith(inlinePrefix)) {
      return token.slice(inlinePrefix.length);
    }
    if (token === name) {
      return argv[index + 1] || null;
    }
  }
  return null;
}

function resolveProfileFromArgs(argv = []) {
  return normalizeProfileName(getOptionValue(argv, '--profile') || DEFAULT_PROFILE);
}

function resolveProjectRootFromArgs(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token) continue;
    if (token.startsWith('--')) {
      const optionName = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (VALUE_OPTIONS.has(optionName) && !token.includes('=')) {
        index += 1;
      }
      continue;
    }
    return normalizeProjectRoot(token);
  }
  return normalizeProjectRoot(null);
}

function stripWrapperFlags(argv = []) {
  return argv.filter((arg) => {
    const token = String(arg || '');
    return token !== '--no-telegram-poller-auto-recover'
      && token !== '--no-bidirectional-wake-watchdog-auto-start';
  });
}

function writeRuntimeJson(projectRoot, filename, payload) {
  const outputPath = path.join(projectRoot, '.squidrun', 'runtime', filename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return outputPath;
}

function writeWatchdogLast(projectRoot, payload) {
  return writeRuntimeJson(projectRoot, 'telegram-poller-watchdog-last.json', payload);
}

function runTelegramPollerAutoRecover(argv = []) {
  if (hasHelpFlag(argv) || argv.includes('--no-telegram-poller-auto-recover')) {
    return { ok: true, skipped: true, reason: 'disabled_or_help' };
  }
  if (resolveProfileFromArgs(argv) !== DEFAULT_PROFILE) {
    return { ok: true, skipped: true, reason: 'profile_not_owner' };
  }

  const projectRoot = resolveProjectRootFromArgs(argv);
  const threshold = getOptionValue(argv, '--telegram-poller-stale-threshold-ms');
  const watchdogPath = path.join(__dirname, 'hm-telegram-poller-watchdog.js');
  const args = [
    watchdogPath,
    'recover',
    `--project-root=${projectRoot}`,
  ];
  if (threshold) {
    args.push(`--threshold-ms=${threshold}`);
  }

  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }

  const payload = {
    ok: result.status === 0 && result.error === undefined,
    startedAt,
    completedAt: new Date().toISOString(),
    projectRoot,
    command: args,
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    result: parsed,
  };
  payload.outputPath = writeWatchdogLast(projectRoot, payload);
  return payload;
}

function writeBidirectionalWakeWatchdogStartLast(projectRoot, payload) {
  return writeRuntimeJson(projectRoot, 'bidirectional-wake-watchdog-start-last.json', payload);
}

function runBidirectionalWakeWatchdogAutoStart(argv = []) {
  if (hasHelpFlag(argv) || argv.includes('--no-bidirectional-wake-watchdog-auto-start')) {
    return { ok: true, skipped: true, reason: 'disabled_or_help' };
  }
  if (resolveProfileFromArgs(argv) !== DEFAULT_PROFILE) {
    return { ok: true, skipped: true, reason: 'profile_not_owner' };
  }

  const projectRoot = resolveProjectRootFromArgs(argv);
  const watchdogPath = path.join(__dirname, 'hm-bidirectional-wake-watchdog.js');
  const args = [
    watchdogPath,
    'start',
  ];

  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      SQUIDRUN_PROJECT_ROOT: projectRoot,
    },
  });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }

  const payload = {
    ok: result.status === 0 && result.error === undefined && parsed?.ok !== false,
    startedAt,
    completedAt: new Date().toISOString(),
    projectRoot,
    command: args,
    status: result.status,
    error: result.error
      ? result.error.message
      : (parsed?.ok === false
        ? (parsed.error || parsed.reason || parsed.status || 'watchdog_start_failed')
        : null),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    result: parsed,
  };
  payload.outputPath = writeBidirectionalWakeWatchdogStartLast(projectRoot, payload);
  return payload;
}

/**
 * TELEGRAM BACKLOG, read into the surface that actually reports health.
 *
 * THE GAP THIS CLOSES. On 2026-08-03 six of James's messages sat undelivered
 * for up to 8.6 hours behind a wedged head while this script reported 100/100.
 * It was not wrong about what it measured — the poller genuinely was fresh, so
 * "are we still receiving" was answered correctly. Nothing asked "is anything
 * being delivered", and a channel can be perfectly fresh and perfectly mute at
 * the same time. The drain knew the whole time; it runs in another process and
 * this one had no way to ask, so the knowledge never reached a score.
 *
 * FAIL-SAFE, NOT FAIL-QUIET. A missing, unreadable, malformed or stale
 * snapshot degrades. It must never read as healthy — "no news is good news" is
 * exactly the reasoning that produced the 100/100, and an absent file is the
 * single most likely way this check silently stops working.
 */
function readTelegramBacklogHealth(projectRoot, nowMs = Date.now(), options = {}) {
  const statePath = options.statePath
    || path.join(projectRoot, '.squidrun', 'runtime', 'telegram-backlog-health.json');

  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // NARROW, EVIDENCE-BASED EXEMPTION, and it is deliberately narrow.
      //
      // A root with no Telegram ingress spool at all has never held an inbound
      // message, so there is no backlog to be behind on and nothing to report.
      // That is a genuine absence of the feature, not an optimistic guess.
      //
      // The moment a spool EXISTS, a missing snapshot degrades — which is the
      // production case, since the live spool holds queued messages. This
      // exemption cannot cover the failing state it would be tempting to
      // silence, and both branches are pinned by test.
      const spoolRoot = path.join(projectRoot, '.squidrun', 'runtime', 'telegram-inbound');
      if (!fs.existsSync(spoolRoot)) {
        return {
          ok: true,
          severity: 'ok',
          reasons: ['no_telegram_ingress_configured'],
          statePath,
          routes: {},
        };
      }
    }
    return {
      ok: false,
      severity: 'degraded',
      reasons: [err && err.code === 'ENOENT' ? 'backlog_snapshot_missing' : `backlog_snapshot_unreadable:${err.message}`],
      statePath,
      routes: {},
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false, severity: 'degraded', reasons: [`backlog_snapshot_malformed:${err.message}`], statePath, routes: {},
    };
  }
  // `typeof [] === 'object'`, so an array passed the old shape check and then
  // iterated as zero routes. Arrays are rejected explicitly at both levels.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !parsed.routes || typeof parsed.routes !== 'object' || Array.isArray(parsed.routes)) {
    return { ok: false, severity: 'degraded', reasons: ['backlog_snapshot_shape_invalid'], statePath, routes: {} };
  }
  // EXACT SCHEMA REQUIRED, PRESENT OR NOT.
  //
  // The first cut read `parsed.schema !== undefined && parsed.schema !== EXPECTED`,
  // so a WRONG schema degraded but an ABSENT one sailed through as valid. That
  // is optional-when-absent — the same fail-open shape as every other defect in
  // this lane, sitting inside the strictness check written to end it. A
  // document that will not say what it is cannot be scored.
  const EXPECTED_SCHEMA = 'telegramBacklogHealth.v0';
  if (parsed.schema !== EXPECTED_SCHEMA) {
    return {
      ok: false,
      severity: 'degraded',
      reasons: [`backlog_snapshot_schema_unknown:${String(parsed.schema)}`],
      statePath,
      routes: {},
    };
  }

  const {
    scoreBacklogHealth,
  } = require('../modules/main/telegram-backlog-health');

  const staleAfterMs = Number.isFinite(Number(options.staleAfterMs))
    ? Number(options.staleAfterMs)
    : 30 * 60 * 1000;

  const reasons = [];
  let severity = 'ok';
  const rank = { ok: 0, degraded: 1, critical: 2 };
  const routes = {};

  const entries = Object.entries(parsed.routes);
  if (entries.length === 0) {
    return { ok: false, severity: 'degraded', reasons: ['backlog_snapshot_has_no_routes'], statePath, routes: {} };
  }

  for (const [routeKey, snapshot] of entries) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      routes[routeKey] = { severity: 'degraded', reasons: ['route_entry_malformed'], headAgeMs: null };
      if (rank.degraded > rank[severity]) severity = 'degraded';
      reasons.push(`${routeKey}:route_entry_malformed`);
      continue;
    }

    // RECOMPUTE THE HEAD AGE against OUR clock from the DURABLE received-at.
    // A stored `oldestPendingAgeMs` is a value the producer asserted, possibly
    // hours ago; scoring it would be comparing the world to itself and always
    // agreeing. Where the durable input is absent the age is UNKNOWN, never
    // inherited from the assertion.
    // A FUTURE received-at IS NOT AGE ZERO.
    //
    // The first cut accepted any finite positive value and then clamped with
    // Math.max(0, nowMs - receivedAtMs). A timestamp in the future is finite
    // and positive, so it passed — and the clamp turned a negative age into 0,
    // the FRESHEST possible reading. A corrupt or forward-skewed clock scored
    // as perfectly healthy, with the clamp hiding the anomaly instead of
    // surfacing it. A message cannot have been received after now; if it claims
    // to have been, the record is untrustworthy and the age is UNKNOWN.
    const receivedAtMs = Number(snapshot.oldestPendingReceivedAtMs);
    const CLOCK_SKEW_TOLERANCE_MS = 60_000;
    const hasDurableAge = Number.isFinite(receivedAtMs)
      && receivedAtMs > 0
      && receivedAtMs <= (nowMs + CLOCK_SKEW_TOLERANCE_MS);
    const futureReceivedAt = Number.isFinite(receivedAtMs)
      && receivedAtMs > (nowMs + CLOCK_SKEW_TOLERANCE_MS);
    const recomputed = hasDurableAge
      ? { ...snapshot, oldestPendingAgeMs: Math.max(0, nowMs - receivedAtMs), oldestPendingAgeUnknown: false }
      : { ...snapshot, oldestPendingAgeMs: null, oldestPendingAgeUnknown: true };

    const scored = scoreBacklogHealth(recomputed, options);
    // The backlog producer writes on drain events, not on a heartbeat. An old
    // snapshot is therefore ambiguous: the reporter may have died, or the lane
    // may simply have remained idle. It stays degraded unless a second live
    // signal proves the narrow quiet case: the poller itself is fresh, its
    // latest result is explicitly empty and error-free, and the persisted
    // route is explicitly empty, unblocked, and not awaiting recovery.
    //
    // A missing/invalid/future timestamp is never eligible. Neither is a stale
    // poller. Those are clock or reporter failures, not evidence of quiet.
    const observedAtMs = Number(snapshot.observedAtMs);
    const observedAtValid = Number.isFinite(observedAtMs) && observedAtMs > 0;
    const observedAtFuture = observedAtValid && observedAtMs > (nowMs + 60_000);
    const staleByAge = observedAtValid
      && !observedAtFuture
      && (nowMs - observedAtMs) > staleAfterMs;
    const stale = !observedAtValid || staleByAge || observedAtFuture;
    const telegramPoller = options.telegramPoller && typeof options.telegramPoller === 'object'
      ? options.telegramPoller
      : null;
    const latestPoll = telegramPoller?.poller && typeof telegramPoller.poller === 'object'
      ? telegramPoller.poller
      : null;
    const activeCursor = telegramPoller?.activeCursor && typeof telegramPoller.activeCursor === 'object'
      ? telegramPoller.activeCursor
      : null;
    const cursorUpdatedAtMs = Number(activeCursor?.updatedAtMs);
    const cursorPredatesSnapshot = latestPoll?.profile === routeKey
      && typeof latestPoll.cursorKey === 'string'
      && latestPoll.cursorKey.length > 0
      && activeCursor?.cursorKey === latestPoll.cursorKey
      && activeCursor.profile === routeKey
      && Number.isFinite(cursorUpdatedAtMs)
      && cursorUpdatedAtMs > 0
      && cursorUpdatedAtMs <= observedAtMs;
    const pollerProvesQuiet = telegramPoller?.ok === true
      && telegramPoller.status === 'fresh'
      && telegramPoller.wedged === false
      && latestPoll?.lastPollStatus === 'ok_empty'
      // Missing is not error-free. The producer must explicitly report null.
      && latestPoll.lastError === null
      // `ok_empty` describes only the latest request. The active durable
      // cursor must also prove that no accepted update postdates this snapshot;
      // otherwise an update followed by an empty poll could hide a dead drain.
      && cursorPredatesSnapshot;
    const snapshotProvesQuiet = scored.severity === 'ok'
      && snapshot.pendingCount === 0
      && snapshot.blockedUpdateId === null
      && snapshot.blockedReason === null
      && snapshot.blockedFailureClass === null
      && snapshot.proofUnattainable === false
      && snapshot.recoveryRequired === false
      && snapshot.orphanedAttemptReason === null;
    const verifiedIdle = staleByAge && pollerProvesQuiet && snapshotProvesQuiet;
    const anomalous = (stale && !verifiedIdle) || futureReceivedAt;
    const routeSeverity = anomalous && rank[scored.severity] < rank.degraded ? 'degraded' : scored.severity;
    const routeReasons = [...scored.reasons];
    if (verifiedIdle) {
      routeReasons.push(`backlog_snapshot_idle_verified:${routeKey}`);
    } else if (stale) {
      routeReasons.push(`backlog_snapshot_stale:${routeKey}`);
    }
    // Named separately from staleness so an operator can tell a dead reporter
    // from a clock that is lying.
    if (futureReceivedAt) routeReasons.push(`oldest_pending_received_at_in_future:${routeKey}`);

    routes[routeKey] = {
      severity: routeSeverity,
      reasons: routeReasons,
      headAgeMs: scored.headAgeMs,
      // v7 §3 Phase L. Projected, not just scored. The severity and the reason
      // string already carry the verdict, and this lane's whole history is
      // verdicts that were correct and unreadable: an operator looking at the
      // startup health document should be able to see WHICH state the channel
      // believes it is in without reverse-engineering it from a reason code.
      activationMode: snapshot.activationMode ?? null,
      activationModeHealthy: snapshot.activationModeHealthy === true,
      // OMITTED IS NOT CANONICAL SUCCESS. `?? null` here would have presented a
      // document that never wrote a reason as the resolver's success shape -
      // erasing, in the projection, the exact incoherence the scorer above was
      // just taught to reject. Explicit null is preserved; absent is named
      // (Architect #159).
      activationModeReason: snapshot.activationModeReason === undefined
        ? 'activation_mode_unreported'
        : snapshot.activationModeReason,
    };
    if (rank[routeSeverity] > rank[severity]) severity = routeSeverity;
    for (const reason of routeReasons) reasons.push(`${routeKey}:${reason}`);
  }

  return { ok: severity === 'ok', severity, reasons, statePath, routes };
}

function runStartupHealth(argv = process.argv.slice(2), io = {}) {
  const effectiveArgv = [...argv];
  const stderr = io.stderr || process.stderr;
  if (!hasFormatFlag(effectiveArgv)) {
    effectiveArgv.push('--markdown');
  }

  const telegramRecovery = runTelegramPollerAutoRecover(effectiveArgv);
  if (telegramRecovery?.ok === false) {
    stderr.write(`Telegram poller watchdog preflight failed: ${telegramRecovery.error || telegramRecovery.stderr || 'unknown'}\n`);
  }

  const bidirectionalWakeWatchdog = runBidirectionalWakeWatchdogAutoStart(effectiveArgv);
  if (bidirectionalWakeWatchdog?.ok === false) {
    stderr.write(`Bidirectional wake watchdog auto-start failed: ${bidirectionalWakeWatchdog.error || bidirectionalWakeWatchdog.stderr || 'unknown'}\n`);
  }

  // TELEGRAM DELIVERY is NOT read here. It is collected by the snapshot owner
  // (hm-health-snapshot `inspectTelegramIngressBacklog`) and penalised in
  // `buildHealthStatus`, so it lands in the published score, JSON and markdown.
  //
  // An earlier version read it HERE, printed to stderr and moved the exit
  // code — which left the emitted snapshot saying OK / 100 with no warning.
  // That is the incident's own shape inside the fix for it: knowledge that
  // never reaches the surface anyone actually looks at. One reader, one place,
  // and that place is the thing that gets serialized.
  return main(stripWrapperFlags(effectiveArgv));
}

module.exports = {
  hasFormatFlag,
  hasHelpFlag,
  readTelegramBacklogHealth,
  resolveProfileFromArgs,
  resolveProjectRootFromArgs,
  runBidirectionalWakeWatchdogAutoStart,
  runStartupHealth,
  runTelegramPollerAutoRecover,
  stripWrapperFlags,
};

// Publish the backlog reader before invoking the CLI. `hm-health-snapshot`
// lazily requires this module while `runStartupHealth()` is executing, so the
// exports must already be complete when this file is the process entrypoint.
// Otherwise Node returns the still-empty circular-require export object and
// the snapshot reports `readTelegramBacklogHealth is not a function`.
if (require.main === module) {
  process.exitCode = runStartupHealth(process.argv.slice(2));
}
