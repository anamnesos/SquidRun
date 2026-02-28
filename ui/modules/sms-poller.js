/**
 * Twilio SMS inbound poller.
 * Uses raw HTTPS polling and relays inbound messages to a callback.
 */

const https = require('https');
const log = require('./logger');

const DEFAULT_POLL_INTERVAL_MS = 10000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_RECENT_SIDS = 50;

let running = false;
let pollTimer = null;
let pollInFlight = false;
let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
let lastPollTimeMs = 0;
let onMessage = null;
let config = null;
let recentSidOrder = [];
let recentSidSet = new Set();

function getMissingTwilioConfigKeys(env = process.env) {
  const missing = [];
  if (!(env.TWILIO_ACCOUNT_SID || '').trim()) missing.push('TWILIO_ACCOUNT_SID');
  if (!(env.TWILIO_AUTH_TOKEN || '').trim()) missing.push('TWILIO_AUTH_TOKEN');
  if (!(env.TWILIO_PHONE_NUMBER || '').trim()) missing.push('TWILIO_PHONE_NUMBER');
  if (!(env.SMS_RECIPIENT || '').trim()) missing.push('SMS_RECIPIENT');
  return missing;
}

function getTwilioConfig(env = process.env) {
  const missingKeys = getMissingTwilioConfigKeys(env);
  if (missingKeys.length > 0) {
    return null;
  }

  const accountSid = (env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = (env.TWILIO_AUTH_TOKEN || '').trim();
  const twilioPhoneNumber = (env.TWILIO_PHONE_NUMBER || '').trim();
  const recipient = (env.SMS_RECIPIENT || '').trim();

  return {
    accountSid,
    authToken,
    twilioPhoneNumber,
    recipient,
  };
}

function buildAuthHeader(currentConfig) {
  return `Basic ${Buffer.from(`${currentConfig.accountSid}:${currentConfig.authToken}`).toString('base64')}`;
}

function buildMessagesPath(currentConfig, sinceMs) {
  const query = new URLSearchParams();
  query.append('To', currentConfig.twilioPhoneNumber);
  query.append('Direction', 'inbound');
  query.append('DateSent>=', new Date(sinceMs).toISOString());
  return `/2010-04-01/Accounts/${encodeURIComponent(currentConfig.accountSid)}/Messages.json?${query.toString()}`;
}

function requestTwilio(method, path, authHeader) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.twilio.com',
        port: 443,
        path,
        method,
        headers: {
          Authorization: authHeader,
        },
      },
      (response) => {
        let responseBody = '';
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: responseBody,
          });
        });
      }
    );

    request.on('error', reject);
    request.end();
  });
}

function parseTimestampMs(message) {
  const source = message?.date_sent || message?.date_created || message?.date_updated || null;
  if (!source) return null;
  const parsed = Date.parse(source);
  return Number.isFinite(parsed) ? parsed : null;
}

function rememberSid(sid) {
  if (!sid || recentSidSet.has(sid)) return;
  recentSidSet.add(sid);
  recentSidOrder.push(sid);
  while (recentSidOrder.length > MAX_RECENT_SIDS) {
    const evictedSid = recentSidOrder.shift();
    if (evictedSid) {
      recentSidSet.delete(evictedSid);
    }
  }
}

function normalizeFrom(rawFrom) {
  const from = typeof rawFrom === 'string' ? rawFrom.trim() : '';
  return from || 'unknown';
}

function normalizeBody(rawBody) {
  if (typeof rawBody !== 'string') return '';
  return rawBody.trim();
}

function summarizeMessageForLog(message) {
  const sid = typeof message?.sid === 'string' && message.sid.trim() ? message.sid.trim() : 'missing';
  const from = normalizeFrom(message?.from);
  const direction = String(message?.direction || '').trim().toLowerCase() || 'unknown';
  return { sid, from, direction };
}

function formatSkipReasonCounts(skipReasonCounts) {
  const entries = Object.entries(skipReasonCounts || {});
  if (entries.length < 1) return 'none';
  return entries
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(',');
}

async function pollNow() {
  if (!running || !config) {
    log.info(
      'SMS',
      `Twilio poll cycle skipped (running=${running}, configReady=${Boolean(config)}, inFlight=${pollInFlight})`
    );
    return;
  }
  if (pollInFlight) {
    log.info('SMS', 'Twilio poll cycle skipped (reason=poll_in_flight)');
    return;
  }
  pollInFlight = true;
  const startedAtMs = Date.now();
  const cycle = {
    status: 'started',
    fetchedCount: 0,
    fetchedMessages: [],
    processedCount: 0,
    deliveredCount: 0,
    skippedCount: 0,
    skippedReasons: {},
  };

  try {
    const path = buildMessagesPath(config, lastPollTimeMs);
    const authHeader = buildAuthHeader(config);
    const response = await requestTwilio('GET', path, authHeader);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      cycle.status = `http_${response.statusCode}`;
      log.warn('SMS', `Twilio polling failed (${response.statusCode})`);
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(response.body || '{}');
    } catch (err) {
      cycle.status = 'invalid_json';
      log.warn('SMS', `Twilio polling returned invalid JSON: ${err.message}`);
      return;
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const sortedMessages = messages
      .slice()
      .sort((left, right) => {
        const leftTs = parseTimestampMs(left) ?? 0;
        const rightTs = parseTimestampMs(right) ?? 0;
        return leftTs - rightTs;
      });

    cycle.fetchedCount = sortedMessages.length;
    cycle.fetchedMessages = sortedMessages.map(summarizeMessageForLog);

    for (const message of sortedMessages) {
      cycle.processedCount += 1;
      const summary = summarizeMessageForLog(message);
      const timestampMs = parseTimestampMs(message);
      const directionInbound = summary.direction.includes('inbound');
      const timestampOlderThanCursor = timestampMs !== null && timestampMs < lastPollTimeMs;
      const hasSid = summary.sid !== 'missing';
      const sidAlreadySeen = hasSid ? recentSidSet.has(summary.sid) : false;
      const sidAccepted = hasSid && !sidAlreadySeen;
      const text = normalizeBody(message.body);
      const hasText = Boolean(text);
      const callbackConfigured = typeof onMessage === 'function';

      let decision = 'skipped';
      let reason = 'unknown';
      let callbackInvoked = false;
      let callbackSucceeded = false;
      let callbackErrorMessage = null;

      if (!directionInbound) {
        reason = 'direction_not_inbound';
      } else if (!hasSid) {
        reason = 'missing_sid';
      } else if (sidAlreadySeen) {
        reason = 'duplicate_sid';
      } else {
        // Preserve existing behavior: once SID passes direction/timestamp/dedup checks,
        // remember it even if body is empty or no callback is configured.
        rememberSid(summary.sid);
        if (!hasText) {
          reason = 'empty_body';
        } else if (!callbackConfigured) {
          reason = 'callback_not_configured';
        } else {
          callbackInvoked = true;
          try {
            onMessage(text, summary.from, {
              sid: summary.sid || null,
              timestampMs,
            });
            callbackSucceeded = true;
            decision = 'delivered';
            reason = 'delivered';
          } catch (err) {
            callbackErrorMessage = err.message;
            reason = 'callback_error';
          }
        }
      }

      log.info(
        'SMS',
        `Twilio message eval sid=${summary.sid} from=${summary.from} direction=${summary.direction} `
          + `checks={inbound:${directionInbound},timestampOlderThanCursor:${timestampOlderThanCursor},sid:${sidAccepted},body:${hasText},callback:${callbackConfigured}} `
          + `callbackInvoked=${callbackInvoked} callbackSucceeded=${callbackSucceeded} `
          + `decision=${decision} reason=${reason}`
      );

      if (decision !== 'delivered') {
        cycle.skippedCount += 1;
        cycle.skippedReasons[reason] = (cycle.skippedReasons[reason] || 0) + 1;
        if (reason === 'callback_error') {
          log.warn(
            'SMS',
            `SMS callback failed (sid=${summary.sid}, from=${summary.from}): ${callbackErrorMessage || 'unknown error'}`
          );
        }
        continue;
      }

      cycle.deliveredCount += 1;
    }
    cycle.status = 'ok';
  } catch (err) {
    cycle.status = 'request_error';
    log.warn('SMS', `Twilio polling error: ${err.message}`);
  } finally {
    const fetchedDescriptors = cycle.fetchedMessages.length > 0
      ? cycle.fetchedMessages
        .map((entry) => `sid=${entry.sid}|from=${entry.from}|direction=${entry.direction}`)
        .join('; ')
      : 'none';
    log.info(
      'SMS',
      `Twilio poll cycle status=${cycle.status} fetched=${cycle.fetchedCount} processed=${cycle.processedCount} `
        + `delivered=${cycle.deliveredCount} skipped=${cycle.skippedCount} skipReasons=${formatSkipReasonCounts(cycle.skippedReasons)} `
        + `messages=[${fetchedDescriptors}]`
    );
    lastPollTimeMs = Math.max(lastPollTimeMs, startedAtMs);
    pollInFlight = false;
  }
}

function start(options = {}) {
  if (running) return true;

  const env = options.env || process.env;
  config = getTwilioConfig(env);
  if (!config) {
    const missingKeys = getMissingTwilioConfigKeys(env);
    log.warn(
      'SMS',
      `Twilio inbound poller start skipped (reason=missing_config, missing=${missingKeys.length > 0 ? missingKeys.join(',') : 'unknown'})`
    );
    return false;
  }

  pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs >= MIN_POLL_INTERVAL_MS
    ? options.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;

  onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
  recentSidOrder = [];
  recentSidSet = new Set();
  lastPollTimeMs = Date.now();
  pollInFlight = false;
  running = true;

  pollTimer = setInterval(() => {
    pollNow().catch((err) => {
      log.warn('SMS', `Twilio polling tick failed: ${err.message}`);
    });
  }, pollIntervalMs);
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }

  log.info('SMS', `Twilio inbound poller started (interval=${pollIntervalMs}ms)`);
  return true;
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  running = false;
  pollInFlight = false;
  onMessage = null;
  config = null;
  recentSidOrder = [];
  recentSidSet = new Set();
  lastPollTimeMs = 0;
}

function isRunning() {
  return running;
}

const _internals = {
  getMissingTwilioConfigKeys,
  getTwilioConfig,
  buildMessagesPath,
  requestTwilio,
  pollNow,
  parseTimestampMs,
};

module.exports = {
  start,
  stop,
  isRunning,
  _internals,
};
