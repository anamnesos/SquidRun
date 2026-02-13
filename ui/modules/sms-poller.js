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

function getTwilioConfig(env = process.env) {
  const accountSid = (env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = (env.TWILIO_AUTH_TOKEN || '').trim();
  const twilioPhoneNumber = (env.TWILIO_PHONE_NUMBER || '').trim();
  const recipient = (env.SMS_RECIPIENT || '').trim();

  if (!accountSid || !authToken || !twilioPhoneNumber || !recipient) {
    return null;
  }

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

async function pollNow() {
  if (!running || !config || pollInFlight) return;
  pollInFlight = true;
  const startedAtMs = Date.now();

  try {
    const path = buildMessagesPath(config, lastPollTimeMs);
    const authHeader = buildAuthHeader(config);
    const response = await requestTwilio('GET', path, authHeader);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      log.warn('SMS', `Twilio polling failed (${response.statusCode})`);
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(response.body || '{}');
    } catch (err) {
      log.warn('SMS', `Twilio polling returned invalid JSON: ${err.message}`);
      return;
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    messages
      .slice()
      .sort((left, right) => {
        const leftTs = parseTimestampMs(left) ?? 0;
        const rightTs = parseTimestampMs(right) ?? 0;
        return leftTs - rightTs;
      })
      .forEach((message) => {
        const direction = String(message.direction || '').toLowerCase();
        if (!direction.includes('inbound')) return;

        const timestampMs = parseTimestampMs(message);
        if (timestampMs !== null && timestampMs < lastPollTimeMs) return;

        const sid = typeof message.sid === 'string' ? message.sid.trim() : '';
        if (!sid || recentSidSet.has(sid)) return;

        rememberSid(sid);
        const text = normalizeBody(message.body);
        if (!text) return;

        if (typeof onMessage === 'function') {
          try {
            onMessage(text, normalizeFrom(message.from));
          } catch (err) {
            log.warn('SMS', `SMS callback failed: ${err.message}`);
          }
        }
      });
  } catch (err) {
    log.warn('SMS', `Twilio polling error: ${err.message}`);
  } finally {
    lastPollTimeMs = Math.max(lastPollTimeMs, startedAtMs);
    pollInFlight = false;
  }
}

function start(options = {}) {
  if (running) return true;

  config = getTwilioConfig(options.env || process.env);
  if (!config) {
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
