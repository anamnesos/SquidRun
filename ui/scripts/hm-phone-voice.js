#!/usr/bin/env node
'use strict';

const http = require('http');

const voiceBrokerLane = require('./hm-voice-broker');

function usage() {
  console.log('Usage: node ui/scripts/hm-phone-voice.js <status|pair> [--base-url <url>] [--ttl-ms <ms>]');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args.shift() || 'status';
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--base-url') {
      options.baseUrl = args[i + 1];
      i += 1;
    } else if (arg === '--ttl-ms') {
      options.ttlMs = Number(args[i + 1]);
      i += 1;
    }
  }
  return { command, options };
}

function getBrokerBaseUrl(status = {}) {
  const address = status?.broker?.address || status?.address;
  const host = address?.address || '127.0.0.1';
  const port = address?.port || 0;
  return port ? `http://${host}:${port}` : null;
}

function postJson(url, payload = {}) {
  const parsed = new URL(url);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsedBody = text;
        try {
          parsedBody = JSON.parse(text);
        } catch (_) {
          // Keep text body.
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          body: parsedBody,
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function buildPhoneUrl(baseUrl, token) {
  const url = new URL('/phone', baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

async function pair(options = {}) {
  const status = voiceBrokerLane.status();
  if (!status.running) {
    return { ok: false, reason: 'voice_broker_not_running', status };
  }
  const localBaseUrl = getBrokerBaseUrl(status);
  if (!localBaseUrl) {
    return { ok: false, reason: 'voice_broker_address_unavailable', status };
  }
  const response = await postJson(`${localBaseUrl}/v1/voice/phone/pairing`, {
    ttlMs: options.ttlMs,
  });
  if (!response.ok || response.body?.ok === false) {
    return {
      ok: false,
      reason: response.body?.reason || 'phone_pairing_failed',
      response,
    };
  }
  const publicBaseUrl = options.baseUrl || localBaseUrl;
  return {
    ok: true,
    localBaseUrl,
    publicBaseUrl,
    phoneUrl: buildPhoneUrl(publicBaseUrl, response.body.token),
    pairing: response.body,
  };
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'status') {
    console.log(JSON.stringify(voiceBrokerLane.status(), null, 2));
    return 0;
  }
  if (command === 'pair') {
    const result = await pair(options);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  usage();
  return 1;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildPhoneUrl,
  getBrokerBaseUrl,
  main,
  pair,
  parseArgs,
};
