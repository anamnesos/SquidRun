#!/usr/bin/env node
/**
 * hm-twitter: CLI tool to post tweets via Twitter/X API v2.
 *
 * Usage:
 *   node hm-twitter.js post "Your tweet text here"
 *   node hm-twitter.js post "Check this out" --url "https://github.com/..."
 *
 * Env required: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET
 *
 * Twitter OAuth 1.0a setup:
 *   1. Create app at https://developer.twitter.com/en/portal/projects-and-apps
 *   2. Enable "Read and Write" permissions
 *   3. Generate access token + secret (under "Keys and tokens")
 *   4. Set all four env vars in .env
 */

const path = require('path');
const https = require('https');
const crypto = require('crypto');
const {
  appendCommsJournalEntry,
  closeCommsJournalStores,
} = require('../modules/main/comms-journal');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function buildJournalMessageId(prefix = 'twitter') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function upsertTwitterJournal(entry = {}) {
  const result = appendCommsJournalEntry({
    channel: 'twitter',
    direction: 'outbound',
    ...entry,
  });
  if (result?.ok !== true) {
    console.warn(`[hm-twitter] journal write unavailable: ${result?.reason || 'unknown'}`);
  }
  return result;
}

function usage() {
  console.log('Usage: node hm-twitter.js post "Your tweet text" [options]');
  console.log('');
  console.log('Commands:');
  console.log('  post    Post a tweet');
  console.log('');
  console.log('Options:');
  console.log('  --url "..."     Append a URL to the tweet text');
  console.log('  --reply-to <id> Tweet ID to reply to (makes this a reply)');
  console.log('');
  console.log('Env required: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET');
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) i += 1;
    options.set(key, value);
  }

  return { positional, options };
}

function getTwitterConfig(env = process.env) {
  return {
    apiKey: (env.TWITTER_API_KEY || '').trim(),
    apiSecret: (env.TWITTER_API_SECRET || '').trim(),
    accessToken: (env.TWITTER_ACCESS_TOKEN || '').trim(),
    accessSecret: (env.TWITTER_ACCESS_SECRET || '').trim(),
  };
}

function getMissingConfigKeys(config) {
  const missing = [];
  if (!config.apiKey) missing.push('TWITTER_API_KEY');
  if (!config.apiSecret) missing.push('TWITTER_API_SECRET');
  if (!config.accessToken) missing.push('TWITTER_ACCESS_TOKEN');
  if (!config.accessSecret) missing.push('TWITTER_ACCESS_SECRET');
  return missing;
}

// OAuth 1.0a signature generation (RFC 5849)
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function generateTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function buildSignatureBaseString(method, url, params) {
  const sortedParams = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
    .join('&');

  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sortedParams)}`;
}

function signRequest(baseString, consumerSecret, tokenSecret) {
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');
}

function buildOAuthHeader(config, method, url) {
  const nonce = generateNonce();
  const timestamp = generateTimestamp();

  const oauthParams = new Map([
    ['oauth_consumer_key', config.apiKey],
    ['oauth_nonce', nonce],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', timestamp],
    ['oauth_token', config.accessToken],
    ['oauth_version', '1.0'],
  ]);

  const baseString = buildSignatureBaseString(method, url, oauthParams);
  const signature = signRequest(baseString, config.apiSecret, config.accessSecret);
  oauthParams.set('oauth_signature', signature);

  const headerParts = Array.from(oauthParams.entries())
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ');

  return `OAuth ${headerParts}`;
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body: responseBody });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function postTweet(config, { text, replyToId }) {
  const apiUrl = 'https://api.twitter.com/2/tweets';
  const authHeader = buildOAuthHeader(config, 'POST', apiUrl);

  const payload = { text };
  if (replyToId) {
    payload.reply = { in_reply_to_tweet_id: replyToId };
  }

  const body = JSON.stringify(payload);

  const response = await httpsRequest({
    hostname: 'api.twitter.com',
    port: 443,
    path: '/2/tweets',
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  let responsePayload = null;
  try { responsePayload = JSON.parse(response.body || '{}'); } catch { responsePayload = null; }

  if (response.statusCode >= 200 && response.statusCode < 300 && responsePayload?.data) {
    return {
      ok: true,
      tweetId: responsePayload.data.id,
      text: responsePayload.data.text,
    };
  }

  const errorDetail = responsePayload?.detail
    || responsePayload?.title
    || (responsePayload?.errors && responsePayload.errors[0]?.message)
    || `HTTP ${response.statusCode}`;

  return {
    ok: false,
    error: errorDetail,
    statusCode: response.statusCode,
  };
}

async function post(options = {}, env = process.env) {
  const messageId = buildJournalMessageId('twitter');
  const { text, url, replyToId } = options;

  const fullText = url ? `${text} ${url}` : text;

  upsertTwitterJournal({
    messageId,
    senderRole: 'system',
    targetRole: 'twitter',
    sentAtMs: Date.now(),
    rawBody: `[tweet] ${fullText}`,
    status: 'recorded',
    attempt: 1,
    metadata: { source: 'hm-twitter' },
  });

  const config = getTwitterConfig(env);
  const missing = getMissingConfigKeys(config);
  if (missing.length > 0) {
    upsertTwitterJournal({
      messageId,
      senderRole: 'system',
      targetRole: 'twitter',
      status: 'failed',
      errorCode: 'missing_config',
      metadata: { missing },
    });
    return { ok: false, error: `Missing required env vars: ${missing.join(', ')}` };
  }

  if (!fullText) {
    return { ok: false, error: 'Tweet text is required' };
  }

  if (fullText.length > 280) {
    return { ok: false, error: `Tweet too long (${fullText.length}/280 characters)` };
  }

  const result = await postTweet(config, { text: fullText, replyToId });

  if (result.ok) {
    upsertTwitterJournal({
      messageId,
      senderRole: 'system',
      targetRole: 'twitter',
      status: 'acked',
      ackStatus: 'twitter_posted',
      metadata: { tweetId: result.tweetId },
    });
  } else {
    upsertTwitterJournal({
      messageId,
      senderRole: 'system',
      targetRole: 'twitter',
      status: 'failed',
      errorCode: 'tweet_failed',
      metadata: { error: result.error, statusCode: result.statusCode },
    });
  }

  return result;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length < 1 || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    process.exit(argv.length < 1 ? 1 : 0);
  }

  const { positional, options } = parseArgs(argv);
  const command = (positional[0] || '').toLowerCase();

  if (command !== 'post') {
    console.error(`[hm-twitter] Unknown command: ${command}. Use "post".`);
    process.exit(1);
  }

  const text = positional.slice(1).join(' ').trim();
  const url = options.get('url') || '';
  const replyToId = options.get('reply-to') || '';

  if (!text) {
    console.error('[hm-twitter] Tweet text is required');
    process.exit(1);
  }

  const result = await post({
    text,
    url: url || undefined,
    replyToId: replyToId || undefined,
  }, env);

  if (!result.ok) {
    closeCommsJournalStores();
    console.error(`[hm-twitter] Failed: ${result.error}`);
    process.exit(1);
  }

  closeCommsJournalStores();
  const tweetUrl = result.tweetId ? `https://twitter.com/i/web/status/${result.tweetId}` : 'success';
  console.log(`[hm-twitter] Posted tweet: ${tweetUrl}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    closeCommsJournalStores();
    console.error(`[hm-twitter] Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  getTwitterConfig,
  getMissingConfigKeys,
  percentEncode,
  generateNonce,
  generateTimestamp,
  buildSignatureBaseString,
  signRequest,
  buildOAuthHeader,
  postTweet,
  post,
  main,
};
