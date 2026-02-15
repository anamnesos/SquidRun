#!/usr/bin/env node
/**
 * hm-sms: CLI tool to send an SMS via Twilio REST API.
 * Usage: node hm-sms.js "Hey, build passed!"
 */

const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

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

async function sendSms(message, env = process.env) {
  const config = getTwilioConfig(env);
  const missing = getMissingConfigKeys(config);
  if (missing.length > 0) {
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
    return {
      ok: true,
      statusCode: response.statusCode,
      sid: payload?.sid || null,
      to: payload?.to || config.toNumber,
    };
  }

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
    console.error(`[hm-sms] Failed: ${result.error}`);
    process.exit(1);
  }

  console.log(`[hm-sms] Sent SMS successfully to ${result.to}${result.sid ? ` (sid: ${result.sid})` : ''}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
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
