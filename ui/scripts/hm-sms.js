#!/usr/bin/env node
/**
 * hm-sms: CLI tool to send an SMS via Twilio REST API.
 * Usage: node hm-sms.js "Hey, build passed!"
 */

const path = require('path');
const https = require('https');
const {
  appendCommsJournalEntry,
  closeCommsJournalStores,
} = require('../modules/main/comms-journal');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asRole(value, fallback = 'system') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized || fallback;
}

function buildJournalMessageId(prefix = 'sms') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function upsertSmsJournal(entry = {}) {
  const result = appendCommsJournalEntry({
    channel: 'sms',
    direction: 'outbound',
    ...entry,
  });
  if (result?.ok !== true) {
    console.warn(`[hm-sms] journal write unavailable: ${result?.reason || 'unknown'}`);
  }
  return result;
}

function usage() {
  console.log('Usage: node hm-sms.js <message>');
  console.log('Env required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, SMS_RECIPIENT');
}

function parseMessage(args = []) {
  return args.join(' ').trim();
}

function getTwilioConfig(env = process.env) {
  const accountSid = (env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = (env.TWILIO_AUTH_TOKEN || '').trim();
  const fromNumber = (env.TWILIO_PHONE_NUMBER || '').trim();
  const toNumber = (env.SMS_RECIPIENT || '').trim();
  return {
    accountSid,
    authToken,
    fromNumber,
    toNumber,
  };
}

function getMissingConfigKeys(config) {
  const missing = [];
  if (!config.accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!config.authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!config.fromNumber) missing.push('TWILIO_PHONE_NUMBER');
  if (!config.toNumber) missing.push('SMS_RECIPIENT');
  return missing;
}

function buildAuthHeader(config) {
  return `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;
}

function requestTwilio(path, authHeader, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.twilio.com',
        port: 443,
        path,
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
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
    request.write(body);
    request.end();
  });
}

async function sendSms(message, env = process.env, options = {}) {
  const opts = asObject(options);
  const messageId = typeof opts.messageId === 'string' && opts.messageId.trim()
    ? opts.messageId.trim()
    : buildJournalMessageId('sms');
  const nowMs = Date.now();
  const senderRole = asRole(opts.senderRole || opts.fromRole || 'system', 'system');
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
  const targetRole = 'user';

  upsertSmsJournal({
    messageId,
    sessionId: sessionId || null,
    senderRole,
    targetRole,
    sentAtMs: nowMs,
    rawBody: message,
    status: 'recorded',
    attempt: 1,
    metadata: {
      source: 'hm-sms',
    },
  });

  const config = getTwilioConfig(env);
  const missing = getMissingConfigKeys(config);
  if (missing.length > 0) {
    upsertSmsJournal({
      messageId,
      sessionId: sessionId || null,
      senderRole,
      targetRole,
      status: 'failed',
      errorCode: 'missing_config',
      metadata: {
        missing,
      },
    });
    return {
      ok: false,
      error: `Missing required env vars: ${missing.join(', ')}`,
    };
  }

  const body = new URLSearchParams({
    To: config.toNumber,
    From: config.fromNumber,
    Body: message,
  }).toString();
  const path = `/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const authHeader = buildAuthHeader(config);

  const response = await requestTwilio(path, authHeader, body);
  let payload = null;
  try {
    payload = JSON.parse(response.body || '{}');
  } catch {
    payload = null;
  }

  if (response.statusCode >= 200 && response.statusCode < 300) {
    upsertSmsJournal({
      messageId,
      sessionId: sessionId || null,
      senderRole,
      targetRole,
      status: 'acked',
      ackStatus: 'sms_delivered',
      metadata: {
        sid: payload?.sid || null,
        to: payload?.to || config.toNumber,
      },
    });
    return {
      ok: true,
      statusCode: response.statusCode,
      sid: payload?.sid || null,
      to: payload?.to || config.toNumber,
    };
  }

  upsertSmsJournal({
    messageId,
    sessionId: sessionId || null,
    senderRole,
    targetRole,
    status: 'failed',
    errorCode: String(response.statusCode || 'twilio_request_failed'),
    metadata: {
      statusCode: response.statusCode || 0,
      error: payload?.message || payload?.detail || null,
    },
  });
  return {
    ok: false,
    statusCode: response.statusCode,
    error: payload?.message || payload?.detail || `Twilio request failed (${response.statusCode})`,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length < 1 || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    process.exit(argv.length < 1 ? 1 : 0);
  }

  const message = parseMessage(argv);
  if (!message) {
    console.error('[hm-sms] Message cannot be empty');
    process.exit(1);
  }

  const result = await sendSms(message, env);
  if (!result.ok) {
    closeCommsJournalStores();
    console.error(`[hm-sms] Failed: ${result.error}`);
    process.exit(1);
  }

  closeCommsJournalStores();
  console.log(`[hm-sms] Sent SMS successfully to ${result.to}${result.sid ? ` (sid: ${result.sid})` : ''}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    closeCommsJournalStores();
    console.error(`[hm-sms] Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseMessage,
  getTwilioConfig,
  getMissingConfigKeys,
  buildAuthHeader,
  requestTwilio,
  sendSms,
  main,
};
