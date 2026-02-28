#!/usr/bin/env node
/**
 * hm-visual-capture: Playwright-based visual capture sidecar for SquidRun.
 *
 * Captures an artifact bundle:
 * - screenshot
 * - Playwright trace
 * - console errors
 * - failed requests / HTTP errors
 * - DOM snapshot
 * - ARIA snapshot
 */

const fs = require('fs');
const path = require('path');
const {
  sendTelegramPhoto,
} = require('./hm-telegram');
const {
  asString,
  asPositiveInt,
  ensureDir,
  resolveProjectPath,
  resolveReadyVisualUrl,
  writeCachedVisualUrl,
  ensureVisualArtifactLayout,
  writeSnapshotJson,
  writeVisualRunManifest,
  resolveLatestScreenshotPath,
} = require('./hm-visual-utils');

const DEFAULT_CAPTURE_TIMEOUT_MS = 25000;
const DEFAULT_SETTLE_MS = 700;
const DEFAULT_WAIT_UNTIL = 'domcontentloaded';
const VALID_WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });

let playwrightModule = null;

function usage() {
  console.log('Usage: node hm-visual-capture.js capture [options]');
  console.log('Options:');
  console.log('  --url <url>                    Explicit URL (highest priority)');
  console.log('  --project-path <path>          Project root (default: cwd/active project)');
  console.log('  --route <path>                 Route appended to resolved URL');
  console.log('  --timeout <ms>                 Capture/nav timeout (default: 25000)');
  console.log('  --ready-timeout <ms>           URL readiness timeout (default: 20000)');
  console.log('  --poll-ms <ms>                 URL readiness poll interval (default: 500)');
  console.log('  --ready-selector <css>         Wait for selector before screenshot');
  console.log('  --wait-until <state>           load|domcontentloaded|networkidle|commit');
  console.log('  --settle-ms <ms>               Extra settle delay after load (default: 700)');
  console.log('  --viewport <WxH>               Example: 1440x900');
  console.log('  --full-page                    Capture full page screenshot');
  console.log('  --headed                       Launch browser in headed mode');
  console.log('  --label <name>                 Run label for artifact ID (default: capture)');
  console.log('  --artifact-root <path>         Artifact root (default: .squidrun/screenshots/visual-captures)');
  console.log('  --max-candidates <n>           Max heuristic URL candidates to probe');
  console.log('  --send-telegram [caption]      Send screenshot to Telegram');
  console.log('Examples:');
  console.log('  node hm-visual-capture.js capture --url http://localhost:3000 --full-page');
  console.log('  node hm-visual-capture.js capture --route /dashboard --send-telegram "Visual check"');
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

function getOption(options, key, fallback = null) {
  if (!options.has(key)) return fallback;
  return options.get(key);
}

function parseViewport(value) {
  const raw = asString(value, '');
  if (!raw) return { ...DEFAULT_VIEWPORT };
  const match = raw.match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) return { ...DEFAULT_VIEWPORT };
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

function normalizeWaitUntil(value) {
  const raw = asString(value, DEFAULT_WAIT_UNTIL).toLowerCase();
  if (VALID_WAIT_UNTIL.has(raw)) return raw;
  return DEFAULT_WAIT_UNTIL;
}

function readPlaywright() {
  if (playwrightModule) return playwrightModule;
  try {
    // Lazy load so usage/help can run even without playwright installed.
    playwrightModule = require('playwright');
    return playwrightModule;
  } catch (err) {
    const message = [
      'Playwright is not installed.',
      'Install from ui/: `npm install playwright --save`',
      'Then install browser binaries: `npx playwright install chromium`',
      `Original error: ${err.message}`,
    ].join('\n');
    throw new Error(message);
  }
}

function normalizeConsoleMessage(msg) {
  return {
    type: msg.type(),
    text: msg.text(),
    location: msg.location(),
    timestamp: new Date().toISOString(),
  };
}

function normalizeRequestFailed(req) {
  const failure = req.failure();
  return {
    kind: 'requestfailed',
    url: req.url(),
    method: req.method(),
    resourceType: req.resourceType(),
    errorText: failure?.errorText || 'unknown',
    timestamp: new Date().toISOString(),
  };
}

function normalizeHttpError(res) {
  return {
    kind: 'http_error',
    url: res.url(),
    status: res.status(),
    statusText: res.statusText(),
    timestamp: new Date().toISOString(),
  };
}

async function collectAriaSnapshot(page) {
  if (page?.accessibility && typeof page.accessibility.snapshot === 'function') {
    return {
      format: 'object',
      snapshot: await page.accessibility.snapshot({ interestingOnly: false }),
    };
  }

  const bodyLocator = page?.locator && typeof page.locator === 'function'
    ? page.locator('body')
    : null;
  if (bodyLocator && typeof bodyLocator.ariaSnapshot === 'function') {
    return {
      format: 'yaml',
      snapshot: await bodyLocator.ariaSnapshot(),
    };
  }

  return {
    format: 'unavailable',
    snapshot: null,
  };
}

function collectCaptureOptions(options) {
  const projectPath = resolveProjectPath({
    projectPath: asString(getOption(options, 'project-path', ''), '') || asString(getOption(options, 'project-root', ''), ''),
  });
  const route = asString(getOption(options, 'route', '/'), '/');

  return {
    projectPath,
    explicitUrl: asString(getOption(options, 'url', ''), ''),
    route,
    timeoutMs: asPositiveInt(getOption(options, 'timeout', DEFAULT_CAPTURE_TIMEOUT_MS), DEFAULT_CAPTURE_TIMEOUT_MS),
    readyTimeoutMs: asPositiveInt(getOption(options, 'ready-timeout', 20000), 20000),
    pollMs: asPositiveInt(getOption(options, 'poll-ms', 500), 500),
    settleMs: asPositiveInt(getOption(options, 'settle-ms', DEFAULT_SETTLE_MS), DEFAULT_SETTLE_MS),
    waitUntil: normalizeWaitUntil(getOption(options, 'wait-until', DEFAULT_WAIT_UNTIL)),
    readySelector: asString(getOption(options, 'ready-selector', ''), ''),
    viewport: parseViewport(getOption(options, 'viewport', '')),
    fullPage: options.has('full-page'),
    headed: options.has('headed'),
    label: asString(getOption(options, 'label', 'capture'), 'capture'),
    artifactRoot: asString(getOption(options, 'artifact-root', ''), ''),
    maxCandidates: asPositiveInt(getOption(options, 'max-candidates', 8), 8),
    telegramRequested: options.has('send-telegram'),
    telegramCaptionRaw: getOption(options, 'send-telegram', ''),
  };
}

function buildDefaultTelegramCaption(summary) {
  return [
    'SquidRun visual capture',
    `URL: ${summary.url}`,
    `Console errors: ${summary.consoleErrorCount}`,
    `Request failures: ${summary.failedRequestCount}`,
  ].join('\n');
}

async function captureVisualBundle(params) {
  const {
    projectPath,
    explicitUrl,
    route,
    timeoutMs,
    readyTimeoutMs,
    pollMs,
    settleMs,
    waitUntil,
    readySelector,
    viewport,
    fullPage,
    headed,
    label,
    artifactRoot,
    maxCandidates,
  } = params;

  const resolved = await resolveReadyVisualUrl({
    projectPath,
    url: explicitUrl,
    route,
    readyTimeoutMs,
    candidateTimeoutMs: Math.min(8000, readyTimeoutMs),
    pollMs,
    maxCandidates,
  });
  if (!resolved.ok) {
    const checks = Array.isArray(resolved.checks) ? resolved.checks : [];
    const detail = checks.map((entry) => `${entry.source}:${entry.candidate} => ${entry.lastError || entry.statusCode || 'not_ready'}`).join('; ');
    throw new Error(`No reachable dev URL found (${resolved.reason || 'unknown_reason'}). ${detail}`);
  }

  const targetUrl = resolved.url;
  const layout = ensureVisualArtifactLayout({
    projectPath,
    artifactRoot,
    label,
  });
  const screenshotPath = path.join(layout.currentDir, 'screenshot.png');
  const domPath = path.join(layout.metaDir, 'dom.html');
  const tracePath = path.join(layout.metaDir, 'trace.zip');
  const latestScreenshotPath = resolveLatestScreenshotPath({ projectPath });
  ensureDir(path.dirname(latestScreenshotPath));

  const consoleErrors = [];
  const requestFailures = [];
  const navigation = {
    url: targetUrl,
    waitUntil,
    readySelector: readySelector || null,
    timeoutMs,
    settleMs,
  };

  const playwright = readPlaywright();
  const browser = await playwright.chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(normalizeConsoleMessage(msg));
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push({
      type: 'pageerror',
      text: err.message,
      stack: err.stack || null,
      timestamp: new Date().toISOString(),
    });
  });
  page.on('requestfailed', (req) => {
    requestFailures.push(normalizeRequestFailed(req));
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      requestFailures.push(normalizeHttpError(res));
    }
  });

  let pageTitle = null;
  let ariaSnapshot = null;
  let traceStopError = null;

  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
    title: `hm-visual-capture:${layout.runId}`,
  });

  try {
    await page.goto(targetUrl, { waitUntil, timeout: timeoutMs });
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10000) }).catch(() => {});
    if (readySelector) {
      await page.waitForSelector(readySelector, { timeout: timeoutMs });
    }
    if (settleMs > 0) {
      await page.waitForTimeout(settleMs);
    }

    await page.screenshot({
      path: screenshotPath,
      fullPage,
      timeout: timeoutMs,
    });
    fs.copyFileSync(screenshotPath, latestScreenshotPath);

    pageTitle = await page.title();
    ariaSnapshot = await collectAriaSnapshot(page);
    const domContent = await page.content();
    fs.writeFileSync(domPath, domContent, 'utf8');
  } finally {
    try {
      await context.tracing.stop({ path: tracePath });
    } catch (err) {
      traceStopError = err.message;
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const consolePath = writeSnapshotJson(layout, 'console-errors.json', consoleErrors, { kind: 'meta' }).path;
  const requestFailuresPath = writeSnapshotJson(layout, 'request-failures.json', requestFailures, { kind: 'meta' }).path;
  const ariaPath = writeSnapshotJson(layout, 'aria-snapshot.json', ariaSnapshot || null, { kind: 'meta' }).path;
  const navigationPath = writeSnapshotJson(layout, 'navigation.json', navigation, { kind: 'meta' }).path;

  const summary = {
    ok: true,
    phase: 'P0',
    runId: layout.runId,
    runDir: layout.runDir,
    source: resolved.source,
    url: targetUrl,
    route: route || '/',
    projectPath,
    screenshotPath,
    latestScreenshotPath,
    tracePath,
    domPath,
    ariaPath,
    navigationPath,
    consolePath,
    requestFailuresPath,
    consoleErrorCount: consoleErrors.length,
    failedRequestCount: requestFailures.length,
    title: pageTitle,
    viewport,
    waitUntil,
    readySelector: readySelector || null,
    fullPage,
    headed,
    traceStopError: traceStopError || null,
    generatedAt: new Date().toISOString(),
    readinessChecks: resolved.checks || [],
  };

  writeVisualRunManifest(layout, {
    summary,
    files: {
      screenshot: screenshotPath,
      latestScreenshot: latestScreenshotPath,
      trace: tracePath,
      dom: domPath,
      aria: ariaPath,
      navigation: navigationPath,
      consoleErrors: consolePath,
      requestFailures: requestFailuresPath,
    },
  });

  writeCachedVisualUrl(projectPath, targetUrl, {
    source: resolved.source,
    lastRunId: layout.runId,
  }, { projectPath });

  return summary;
}

async function maybeSendTelegram(summary, options) {
  if (!options.telegramRequested) return null;
  const caption = asString(options.telegramCaptionRaw, '') || buildDefaultTelegramCaption(summary);
  const result = await sendTelegramPhoto(summary.screenshotPath, caption, process.env, {
    senderRole: 'builder',
    targetRole: 'user',
  });
  if (!result.ok) {
    throw new Error(result.error || 'telegram_send_failed');
  }
  return {
    ok: true,
    chatId: result.chatId || null,
    messageId: result.messageId || null,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const { positional, options } = parseArgs(argv);
  const command = asString(positional[0], '').toLowerCase();
  if (command !== 'capture') {
    usage();
    process.exit(1);
  }

  const captureOptions = collectCaptureOptions(options);
  const summary = await captureVisualBundle(captureOptions);
  const telegram = await maybeSendTelegram(summary, captureOptions);

  const output = {
    ...summary,
    telegram: telegram || null,
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`hm-visual-capture failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  parseViewport,
  normalizeWaitUntil,
  collectCaptureOptions,
  captureVisualBundle,
  maybeSendTelegram,
  main,
};
