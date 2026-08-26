#!/usr/bin/env node
/**
 * test-image-gen.js — Standalone test for Recraft V3 + OpenAI gpt-image-1 APIs.
 * Usage: node ui/scripts/test-image-gen.js
 *
 * Loads API keys from .env, makes the same calls image-gen.js makes,
 * and logs full request/response for debugging.
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const PROMPT = process.argv[2] || 'a red fox sitting on a mossy log in a forest';

// ── Load .env ──────────────────────────────────────────────────────────────────
function loadEnv() {
  const keys = {};
  if (!fs.existsSync(ENV_PATH)) {
    console.error('[ERROR] .env not found at', ENV_PATH);
    process.exit(1);
  }
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').replace(/\r/g, '').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) keys[m[1]] = m[2];
  }
  return keys;
}

// ── Recraft V3 ─────────────────────────────────────────────────────────────────
async function testRecraft(apiKey) {
  console.log('\n' + '='.repeat(60));
  console.log('  RECRAFT V3 TEST');
  console.log('='.repeat(60));

  if (!apiKey) {
    console.log('[SKIP] RECRAFT_API_KEY not set');
    return false;
  }
  console.log('[KEY]  ...%s (%d chars)', apiKey.slice(-4), apiKey.length);

  const url = 'https://external.api.recraft.ai/v1/images/generations';
  const body = {
    model: 'recraftv3',
    prompt: PROMPT,
    style: 'realistic_image',
    size: '1024x1024',
  };

  console.log('[URL]  %s', url);
  console.log('[BODY] %s', JSON.stringify(body, null, 2));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    console.log('[STATUS] %d %s', res.status, res.statusText);
    console.log('[HEADERS]');
    for (const [k, v] of res.headers) {
      console.log('  %s: %s', k, v);
    }

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }

    if (json) {
      console.log('[RESPONSE JSON]');
      console.log(JSON.stringify(json, null, 2));
    } else {
      console.log('[RESPONSE TEXT]');
      console.log(text.slice(0, 2000));
    }

    if (res.ok && json?.data?.[0]?.url) {
      console.log('\n[SUCCESS] Image URL: %s', json.data[0].url);
      return true;
    } else {
      console.log('\n[FAILED] Status %d', res.status);
      return false;
    }
  } catch (err) {
    clearTimeout(timeout);
    console.log('[ERROR] %s', err.message);
    return false;
  }
}

// ── Recraft V3 alternate payloads (try variations to find what works) ───────
async function testRecraftVariations(apiKey) {
  if (!apiKey) return;

  const variations = [
    {
      label: 'Without model field',
      body: { prompt: PROMPT, style: 'realistic_image', size: '1024x1024' },
    },
    {
      label: 'Without style field',
      body: { model: 'recraftv3', prompt: PROMPT, size: '1024x1024' },
    },
    {
      label: 'Without size field',
      body: { model: 'recraftv3', prompt: PROMPT, style: 'realistic_image' },
    },
    {
      label: 'Minimal (prompt only)',
      body: { prompt: PROMPT },
    },
    {
      label: 'n=1 added',
      body: { model: 'recraftv3', prompt: PROMPT, style: 'realistic_image', size: '1024x1024', n: 1 },
    },
    {
      label: 'response_format=url',
      body: { model: 'recraftv3', prompt: PROMPT, style: 'realistic_image', size: '1024x1024', response_format: 'url' },
    },
  ];

  for (const v of variations) {
    console.log('\n--- Variation: %s ---', v.label);
    console.log('[BODY] %s', JSON.stringify(v.body));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch('https://external.api.recraft.ai/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(v.body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }

      if (res.ok) {
        console.log('[OK %d] %s', res.status, json?.data?.[0]?.url || '(no url)');
        return v; // Return first successful variation
      } else {
        const errMsg = json?.error?.message || json?.message || json?.detail || text.slice(0, 200);
        console.log('[FAIL %d] %s', res.status, errMsg);
      }
    } catch (err) {
      clearTimeout(timeout);
      console.log('[ERROR] %s', err.message);
    }
  }
  return null;
}

// ── OpenAI gpt-image-1 ────────────────────────────────────────────────────────
async function testOpenAI(apiKey) {
  console.log('\n' + '='.repeat(60));
  console.log('  OPENAI gpt-image-1 TEST');
  console.log('='.repeat(60));

  if (!apiKey) {
    console.log('[SKIP] OPENAI_API_KEY not set');
    return false;
  }
  console.log('[KEY]  ...%s (%d chars)', apiKey.slice(-4), apiKey.length);

  const url = 'https://api.openai.com/v1/images/generations';
  const body = {
    model: 'gpt-image-1',
    prompt: PROMPT,
    n: 1,
    size: '1024x1024',
    quality: 'auto',
  };

  console.log('[URL]  %s', url);
  console.log('[BODY] %s', JSON.stringify(body, null, 2));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    console.log('[STATUS] %d %s', res.status, res.statusText);

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }

    if (json) {
      // Truncate b64 data for display
      const display = JSON.parse(JSON.stringify(json));
      if (display?.data?.[0]?.b64_json) {
        display.data[0].b64_json = display.data[0].b64_json.slice(0, 80) + '... (truncated)';
      }
      console.log('[RESPONSE JSON]');
      console.log(JSON.stringify(display, null, 2));
    } else {
      console.log('[RESPONSE TEXT]');
      console.log(text.slice(0, 2000));
    }

    if (res.ok && json?.data?.[0]?.b64_json) {
      console.log('\n[SUCCESS] Got base64 image data (%d chars)', json.data[0].b64_json.length);
      return true;
    } else {
      console.log('\n[FAILED] Status %d', res.status);
      return false;
    }
  } catch (err) {
    clearTimeout(timeout);
    console.log('[ERROR] %s', err.message);
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Image Gen API Test');
  console.log('Prompt: "%s"', PROMPT);
  console.log('Time: %s', new Date().toISOString());

  const env = loadEnv();

  // Test Recraft first (primary)
  const recraftOk = await testRecraft(env.RECRAFT_API_KEY);

  // If Recraft failed, try variations to diagnose
  if (!recraftOk && env.RECRAFT_API_KEY) {
    console.log('\n' + '='.repeat(60));
    console.log('  RECRAFT VARIATION TESTS (diagnosing 400)');
    console.log('='.repeat(60));
    const winner = await testRecraftVariations(env.RECRAFT_API_KEY);
    if (winner) {
      console.log('\n[FIX FOUND] Working payload: %s', winner.label);
      console.log('[FIX BODY]  %s', JSON.stringify(winner.body));
    } else {
      console.log('\n[NO FIX] All Recraft variations failed');
    }
  }

  // Test OpenAI (fallback)
  const openaiOk = await testOpenAI(env.OPENAI_API_KEY);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  SUMMARY');
  console.log('='.repeat(60));
  console.log('Recraft V3:     %s', recraftOk ? 'OK' : 'FAILED');
  console.log('OpenAI image-1: %s', openaiOk ? 'OK' : 'FAILED');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
