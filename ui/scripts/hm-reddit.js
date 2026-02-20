#!/usr/bin/env node
/**
 * hm-reddit: CLI tool to post to Reddit via OAuth2 API.
 *
 * Usage:
 *   node hm-reddit.js post --subreddit <name> --title "..." [--body "..."] [--flair "..."]
 *   node hm-reddit.js post --subreddit <name> --title "..." --url "..." [--flair "..."]
 *
 * Env required: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
 *
 * Reddit OAuth2 password grant flow (script-type app):
 *   1. Create app at https://www.reddit.com/prefs/apps/ (type: script)
 *   2. Copy client ID (under app name) and secret
 *   3. Set env vars in .env
 */

const path = require('path');
const https = require('https');
const querystring = require('querystring');
const {
  appendCommsJournalEntry,
  closeCommsJournalStores,
} = require('../modules/main/comms-journal');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const USER_AGENT = 'squidrun-reddit-cli/1.0.0';

function buildJournalMessageId(prefix = 'reddit') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function upsertRedditJournal(entry = {}) {
  const result = appendCommsJournalEntry({
    channel: 'reddit',
    direction: 'outbound',
    ...entry,
  });
  if (result?.ok !== true) {
    console.warn(`[hm-reddit] journal write unavailable: ${result?.reason || 'unknown'}`);
  }
  return result;
}

function usage() {
  console.log('Usage: node hm-reddit.js post --subreddit <name> --title "..." [options]');
  console.log('');
  console.log('Commands:');
  console.log('  post    Submit a new post to a subreddit');
  console.log('');
  console.log('Options:');
  console.log('  --subreddit <name>  Target subreddit (without r/ prefix)');
  console.log('  --title "..."       Post title (required)');
  console.log('  --body "..."        Post body text (self post)');
  console.log('  --url "..."         Link URL (link post — mutually exclusive with --body)');
  console.log('  --flair "..."       Flair text (optional)');
  console.log('');
  console.log('Env required: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD');
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

function getRedditConfig(env = process.env) {
  return {
    clientId: (env.REDDIT_CLIENT_ID || '').trim(),
    clientSecret: (env.REDDIT_CLIENT_SECRET || '').trim(),
    username: (env.REDDIT_USERNAME || '').trim(),
    password: (env.REDDIT_PASSWORD || '').trim(),
  };
}

function getMissingConfigKeys(config) {
  const missing = [];
  if (!config.clientId) missing.push('REDDIT_CLIENT_ID');
  if (!config.clientSecret) missing.push('REDDIT_CLIENT_SECRET');
  if (!config.username) missing.push('REDDIT_USERNAME');
  if (!config.password) missing.push('REDDIT_PASSWORD');
  return missing;
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

async function getAccessToken(config) {
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const body = querystring.stringify({
    grant_type: 'password',
    username: config.username,
    password: config.password,
  });

  const response = await httpsRequest({
    hostname: 'www.reddit.com',
    port: 443,
    path: '/api/v1/access_token',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': USER_AGENT,
    },
  }, body);

  let payload = null;
  try { payload = JSON.parse(response.body || '{}'); } catch { payload = null; }

  if (response.statusCode < 200 || response.statusCode >= 300 || !payload?.access_token) {
    const error = payload?.error || payload?.message || `HTTP ${response.statusCode}`;
    throw new Error(`Reddit auth failed: ${error}`);
  }

  return payload.access_token;
}

async function submitPost(accessToken, { subreddit, title, body, url, flair }) {
  const formFields = {
    api_type: 'json',
    sr: subreddit,
    title,
    kind: url ? 'link' : 'self',
  };

  if (url) {
    formFields.url = url;
  } else if (body) {
    formFields.text = body;
  }

  if (flair) {
    formFields.flair_text = flair;
  }

  const formBody = querystring.stringify(formFields);

  const response = await httpsRequest({
    hostname: 'oauth.reddit.com',
    port: 443,
    path: '/api/submit',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formBody),
      'User-Agent': USER_AGENT,
    },
  }, formBody);

  let payload = null;
  try { payload = JSON.parse(response.body || '{}'); } catch { payload = null; }

  const jsonData = payload?.json?.data;
  const errors = payload?.json?.errors;

  if (errors && errors.length > 0) {
    const errorMsg = errors.map(e => (Array.isArray(e) ? e.join(': ') : String(e))).join('; ');
    return { ok: false, error: errorMsg };
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return {
      ok: false,
      error: payload?.message || `Reddit submit failed (HTTP ${response.statusCode})`,
      statusCode: response.statusCode,
    };
  }

  return {
    ok: true,
    url: jsonData?.url || null,
    id: jsonData?.id || null,
    name: jsonData?.name || null,
  };
}

async function post(options = {}, env = process.env) {
  const messageId = buildJournalMessageId('reddit');
  const { subreddit, title, body, url, flair } = options;

  upsertRedditJournal({
    messageId,
    senderRole: 'system',
    targetRole: 'reddit',
    sentAtMs: Date.now(),
    rawBody: `[reddit post] r/${subreddit}: ${title}`,
    status: 'recorded',
    attempt: 1,
    metadata: { source: 'hm-reddit', subreddit, title },
  });

  const config = getRedditConfig(env);
  const missing = getMissingConfigKeys(config);
  if (missing.length > 0) {
    upsertRedditJournal({
      messageId,
      senderRole: 'system',
      targetRole: 'reddit',
      status: 'failed',
      errorCode: 'missing_config',
      metadata: { missing },
    });
    return { ok: false, error: `Missing required env vars: ${missing.join(', ')}` };
  }

  if (!subreddit || !title) {
    return { ok: false, error: 'subreddit and title are required' };
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(config);
  } catch (err) {
    upsertRedditJournal({
      messageId,
      senderRole: 'system',
      targetRole: 'reddit',
      status: 'failed',
      errorCode: 'auth_failed',
      metadata: { error: err.message },
    });
    return { ok: false, error: err.message };
  }

  const result = await submitPost(accessToken, { subreddit, title, body, url, flair });

  if (result.ok) {
    upsertRedditJournal({
      messageId,
      senderRole: 'system',
      targetRole: 'reddit',
      status: 'acked',
      ackStatus: 'reddit_posted',
      metadata: { postUrl: result.url, postId: result.id },
    });
  } else {
    upsertRedditJournal({
      messageId,
      senderRole: 'system',
      targetRole: 'reddit',
      status: 'failed',
      errorCode: 'submit_failed',
      metadata: { error: result.error },
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
    console.error(`[hm-reddit] Unknown command: ${command}. Use "post".`);
    process.exit(1);
  }

  const subreddit = options.get('subreddit') || '';
  const title = options.get('title') || '';
  const body = options.get('body') || '';
  const url = options.get('url') || '';
  const flair = options.get('flair') || '';

  if (!subreddit || typeof subreddit !== 'string') {
    console.error('[hm-reddit] --subreddit is required');
    process.exit(1);
  }
  if (!title || typeof title !== 'string') {
    console.error('[hm-reddit] --title is required');
    process.exit(1);
  }

  const result = await post({ subreddit, title, body: body || undefined, url: url || undefined, flair: flair || undefined }, env);

  if (!result.ok) {
    closeCommsJournalStores();
    console.error(`[hm-reddit] Failed: ${result.error}`);
    process.exit(1);
  }

  closeCommsJournalStores();
  console.log(`[hm-reddit] Posted to r/${subreddit}: ${result.url || result.id || 'success'}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    closeCommsJournalStores();
    console.error(`[hm-reddit] Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  getRedditConfig,
  getMissingConfigKeys,
  getAccessToken,
  submitPost,
  post,
  main,
};
