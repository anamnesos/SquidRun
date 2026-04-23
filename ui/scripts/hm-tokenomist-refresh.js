#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'https://tokenomist.ai/?sort-key=upcomingEvent.dateUnix&sort-direction=asc&page-size=25&watchlist=false';
const DEFAULT_OUTPUT_PATH = path.resolve(__dirname, '..', '..', 'tokenomist-current.yml');
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_SETTLE_MS = 3000;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_WAIT_UNTIL = 'domcontentloaded';
const VALID_WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);
const ROW_PATTERN = /row "Picture of .* token .*"/g;

let playwrightModule = null;

function usage() {
  console.log('Usage: node ui/scripts/hm-tokenomist-refresh.js [options]');
  console.log('Options:');
  console.log(`  --url <url>           Tokenomist unlock page (default: ${DEFAULT_URL})`);
  console.log(`  --output <path>       Output YAML path (default: ${DEFAULT_OUTPUT_PATH})`);
  console.log(`  --timeout <ms>        Overall timeout (default: ${DEFAULT_TIMEOUT_MS})`);
  console.log(`  --settle-ms <ms>      Initial settle after load (default: ${DEFAULT_SETTLE_MS})`);
  console.log(`  --poll-ms <ms>        Snapshot polling interval (default: ${DEFAULT_POLL_MS})`);
  console.log(`  --wait-until <state>  load|domcontentloaded|networkidle|commit (default: ${DEFAULT_WAIT_UNTIL})`);
  console.log('  --headed              Launch browser in headed mode');
  console.log('  --stdout              Print snapshot to stdout instead of writing a file');
  console.log('  --json                Print machine-readable result');
  console.log('  --help                Show this help');
}

function asString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function asPositiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function normalizeWaitUntil(value) {
  const token = asString(value, DEFAULT_WAIT_UNTIL).toLowerCase();
  return VALID_WAIT_UNTIL.has(token) ? token : DEFAULT_WAIT_UNTIL;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    url: DEFAULT_URL,
    outputPath: DEFAULT_OUTPUT_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    settleMs: DEFAULT_SETTLE_MS,
    pollMs: DEFAULT_POLL_MS,
    waitUntil: DEFAULT_WAIT_UNTIL,
    headed: false,
    stdout: false,
    json: false,
    help: false,
  };

  const args = Array.isArray(argv) ? [...argv] : [];
  while (args.length > 0) {
    const token = args.shift();
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--headed') {
      options.headed = true;
      continue;
    }
    if (token === '--stdout') {
      options.stdout = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--url' && args.length > 0) {
      options.url = asString(args.shift(), DEFAULT_URL);
      continue;
    }
    if ((token === '--output' || token === '--out') && args.length > 0) {
      options.outputPath = path.resolve(args.shift());
      continue;
    }
    if (token === '--timeout' && args.length > 0) {
      options.timeoutMs = asPositiveInt(args.shift(), DEFAULT_TIMEOUT_MS);
      continue;
    }
    if (token === '--settle-ms' && args.length > 0) {
      options.settleMs = asPositiveInt(args.shift(), DEFAULT_SETTLE_MS);
      continue;
    }
    if (token === '--poll-ms' && args.length > 0) {
      options.pollMs = asPositiveInt(args.shift(), DEFAULT_POLL_MS);
      continue;
    }
    if (token === '--wait-until' && args.length > 0) {
      options.waitUntil = normalizeWaitUntil(args.shift());
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function readPlaywright() {
  if (playwrightModule) return playwrightModule;
  try {
    playwrightModule = require('playwright');
    return playwrightModule;
  } catch (error) {
    throw new Error([
      'Playwright is not available from ui/node_modules.',
      'Run from the project root after installing dependencies in ui/.',
      `Original error: ${error.message}`,
    ].join('\n'));
  }
}

function countUnlockRows(snapshot = '') {
  return Array.from(String(snapshot).matchAll(ROW_PATTERN)).length;
}

function validateSnapshot(snapshot = '') {
  const rowCount = countUnlockRows(snapshot);
  return {
    ok: rowCount > 0,
    rowCount,
    hasDashboardHeading: String(snapshot).includes('heading "Token Unlocks Dashboard"'),
  };
}

async function dismissBuilderPopup(page) {
  const dialog = page.locator('[role="dialog"]').first();
  if (!await dialog.count().catch(() => 0)) return false;

  const closeButton = dialog.locator('button').first();
  if (await closeButton.count().catch(() => 0)) {
    await closeButton.click({ timeout: 5000 }).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }

  await page.waitForTimeout(500).catch(() => {});
  return true;
}

async function captureUnlockSnapshot(page, options = {}) {
  const timeoutMs = asPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollMs = asPositiveInt(options.pollMs, DEFAULT_POLL_MS);
  const startedAt = Date.now();
  let lastSnapshot = '';
  const bodyLocator = page?.locator && typeof page.locator === 'function'
    ? page.locator('body')
    : null;

  if (!bodyLocator || typeof bodyLocator.ariaSnapshot !== 'function') {
    throw new Error('This Playwright build does not expose locator.ariaSnapshot(), so it cannot refresh tokenomist-current.yml in the expected format.');
  }

  while ((Date.now() - startedAt) < timeoutMs) {
    lastSnapshot = await bodyLocator.ariaSnapshot();
    const validation = validateSnapshot(lastSnapshot);
    if (validation.ok) {
      return {
        snapshot: lastSnapshot,
        rowCount: validation.rowCount,
      };
    }
    await page.waitForTimeout(pollMs);
  }

  const validation = validateSnapshot(lastSnapshot);
  throw new Error(
    `Timed out waiting for Tokenomist unlock rows after ${timeoutMs}ms (rows=${validation.rowCount}, dashboard=${validation.hasDashboardHeading}).`
  );
}

function writeFileAtomic(targetPath, content) {
  const absolutePath = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, absolutePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
  return absolutePath;
}

async function runRefresh(options = {}) {
  const {
    chromium,
  } = readPlaywright();

  const browser = await chromium.launch({ headless: !options.headed });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(options.url || DEFAULT_URL, {
      waitUntil: normalizeWaitUntil(options.waitUntil),
      timeout: asPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    });
    await page.waitForTimeout(asPositiveInt(options.settleMs, DEFAULT_SETTLE_MS));
    await dismissBuilderPopup(page);

    const captured = await captureUnlockSnapshot(page, options);
    const fetchedAt = new Date().toISOString();
    const result = {
      ok: true,
      fetchedAt,
      url: options.url || DEFAULT_URL,
      rowCount: captured.rowCount,
      outputPath: options.stdout ? null : path.resolve(options.outputPath || DEFAULT_OUTPUT_PATH),
      snapshot: captured.snapshot,
    };

    if (!options.stdout) {
      writeFileAtomic(result.outputPath, captured.snapshot);
    }

    return result;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    usage();
    return;
  }

  const result = await runRefresh(options);
  if (options.json) {
    const output = {
      ok: result.ok,
      fetchedAt: result.fetchedAt,
      url: result.url,
      rowCount: result.rowCount,
      outputPath: result.outputPath,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (options.stdout) {
    process.stdout.write(result.snapshot);
    if (!result.snapshot.endsWith('\n')) {
      process.stdout.write('\n');
    }
    return;
  }

  console.log(`Refreshed Tokenomist snapshot: ${result.rowCount} rows -> ${result.outputPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_OUTPUT_PATH,
  DEFAULT_POLL_MS,
  DEFAULT_SETTLE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_URL,
  DEFAULT_WAIT_UNTIL,
  countUnlockRows,
  dismissBuilderPopup,
  parseArgs,
  runRefresh,
  validateSnapshot,
  writeFileAtomic,
};
