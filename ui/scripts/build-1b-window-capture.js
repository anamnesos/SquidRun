'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const SURFACES = Object.freeze([
  Object.freeze({ id: 'main', html: 'index.html', openKey: null }),
  Object.freeze({ id: 'pane-host', html: 'pane-host.html', openKey: null }),
  Object.freeze({
    id: 'live-task-audit',
    html: 'live-task-audit-sidecar.html',
    openKey: 'live-task-audit-sidecar',
  }),
  Object.freeze({ id: 'spine-overlay', html: 'spine-overlay.html', openKey: 'spine-overlay' }),
]);

function toText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function parseArgs(argv = []) {
  const options = {
    cdpPort: 9333,
    artifactDir: null,
    expectCommit: null,
    titlePrefix: 'Build 1B H0 TEST COPY',
    timeoutMs: 20_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--cdp-port') {
      options.cdpPort = Number(argv[index + 1]);
      index += 1;
    } else if (token === '--artifact-dir') {
      options.artifactDir = toText(argv[index + 1]);
      index += 1;
    } else if (token === '--expect-commit') {
      options.expectCommit = toText(argv[index + 1]);
      index += 1;
    } else if (token === '--title-prefix') {
      options.titlePrefix = toText(argv[index + 1]);
      index += 1;
    } else if (token === '--timeout-ms') {
      options.timeoutMs = Number(argv[index + 1]);
      index += 1;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  if (!Number.isInteger(options.cdpPort) || options.cdpPort < 1 || options.cdpPort > 65535) {
    throw new Error('--cdp-port must be an integer from 1 to 65535');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 120_000) {
    throw new Error('--timeout-ms must be between 1000 and 120000');
  }
  if (!options.titlePrefix) throw new Error('--title-prefix must not be empty');
  if (options.expectCommit && !/^[0-9a-f]{7,40}$/i.test(options.expectCommit)) {
    throw new Error('--expect-commit must be a 7-40 character git object id');
  }
  return options;
}

function usage() {
  console.log([
    'Usage: node ui/scripts/build-1b-window-capture.js [options]',
    '',
    'Options:',
    '  --cdp-port <port>       Throwaway packaged app CDP port (default 9333)',
    '  --artifact-dir <path>   Output directory for screenshots and receipt JSON',
    '  --expect-commit <sha>    Require capture runner checkout to match this commit',
    '  --title-prefix <text>   TEST COPY title prefix',
    '  --timeout-ms <ms>       Attach/window timeout (default 20000)',
  ].join('\n'));
}

function verifyExpectedCommit(expectedCommit, repoRoot = path.resolve(__dirname, '..', '..')) {
  if (!expectedCommit) throw new Error('--expect-commit is required');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!head.toLowerCase().startsWith(expectedCommit.toLowerCase())) {
    throw new Error(`expected commit ${expectedCommit}, checkout is ${head}`);
  }
  return head;
}

function normalizeUrlPath(url) {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/\\/g, '/');
  } catch {
    return String(url || '').replace(/\\/g, '/');
  }
}

function identifySurface(url) {
  const pathname = normalizeUrlPath(url).toLowerCase();
  return SURFACES.find((surface) => pathname.endsWith(`/${surface.html.toLowerCase()}`)) || null;
}

function getAllPages(browser) {
  return browser.contexts().flatMap((context) => context.pages());
}

function findPageForSurface(browser, surface) {
  return getAllPages(browser).find((page) => identifySurface(page.url())?.id === surface.id) || null;
}

async function waitForSurface(browser, surface, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const page = findPageForSurface(browser, surface);
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`surface timeout: ${surface.id} (${surface.html})`);
}

function attachPageDiagnostics(page, diagnostics) {
  const pageKey = () => identifySurface(page.url())?.id || page.url() || 'unknown-page';
  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return;
    diagnostics.push({
      surface: pageKey(),
      class: `console.${message.type()}`,
      text: message.text(),
    });
  });
  page.on('pageerror', (error) => {
    diagnostics.push({
      surface: pageKey(),
      class: 'pageerror',
      text: error?.stack || error?.message || String(error),
    });
  });
}

async function inspectPage(page, surface, options) {
  await page.waitForLoadState('domcontentloaded', { timeout: options.timeoutMs });
  const title = `${options.titlePrefix} - ${surface.id}`;
  const inspection = await page.evaluate((nextTitle) => {
    document.title = nextTitle;
    const body = document.body;
    const rect = body?.getBoundingClientRect?.() || null;
    const style = body ? getComputedStyle(body) : null;
    const bridge = window.squidrun || window.squidrunAPI || null;
    return {
      title: document.title,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      documentHidden: document.hidden,
      bridgePresent: Boolean(bridge),
      invokePresent: typeof bridge?.invoke === 'function',
      rendererModulesPresent: Boolean(bridge?.rendererModules),
      rendererModulesLoadError: bridge?.rendererModulesLoadError || null,
      body: body ? {
        childElementCount: body.childElementCount,
        textBytes: new TextEncoder().encode(body.innerText || body.textContent || '').length,
        width: rect?.width || 0,
        height: rect?.height || 0,
        display: style?.display || null,
        visibility: style?.visibility || null,
        opacity: style?.opacity || null,
      } : null,
    };
  }, title);

  const screenshotPath = path.join(options.artifactDir, `${surface.id}.png`);
  const cdp = await page.context().newCDPSession(page);
  try {
    const screenshotResult = await Promise.race([
      cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
      }),
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `CDP screenshot timeout: ${surface.id} (${surface.html})`,
        )), options.timeoutMs);
        timer.unref?.();
      }),
    ]);
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotResult.data, 'base64'));
  } finally {
    await cdp.detach().catch(() => {});
  }
  const png = PNG.sync.read(fs.readFileSync(screenshotPath));
  const screenshot = {
    path: screenshotPath,
    bytes: fs.statSync(screenshotPath).size,
    width: png.width,
    height: png.height,
  };
  const ok = inspection.readyState === 'complete'
    && inspection.bridgePresent
    && inspection.invokePresent
    && !inspection.rendererModulesLoadError
    && inspection.body?.childElementCount > 0
    && inspection.body?.width > 0
    && inspection.body?.height > 0
    && screenshot.bytes > 0
    && screenshot.width > 0
    && screenshot.height > 0;
  return {
    id: surface.id,
    html: surface.html,
    url: page.url(),
    ok,
    inspection,
    screenshot,
  };
}

async function capture(options) {
  if (!options.artifactDir) throw new Error('--artifact-dir is required');
  const head = verifyExpectedCommit(options.expectCommit);
  options.artifactDir = path.resolve(options.artifactDir);
  fs.mkdirSync(options.artifactDir, { recursive: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.cdpPort}`, {
    timeout: options.timeoutMs,
  });
  const diagnostics = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) attachPageDiagnostics(page, diagnostics);
    context.on('page', (page) => attachPageDiagnostics(page, diagnostics));
  }

  try {
    const mainSurface = SURFACES.find((surface) => surface.id === 'main');
    const mainPage = await waitForSurface(browser, mainSurface, options.timeoutMs);
    for (const surface of SURFACES.filter((candidate) => candidate.openKey)) {
      const result = await mainPage.evaluate(async (windowKey) => {
        const bridge = window.squidrun || window.squidrunAPI;
        if (!bridge || typeof bridge.invoke !== 'function') {
          return { ok: false, reason: 'preload_invoke_unavailable' };
        }
        return bridge.invoke('open-app-window', { windowKey });
      }, surface.openKey);
      if (!result?.ok) throw new Error(`open ${surface.id} failed: ${result?.reason || result?.status || 'unknown'}`);
      await waitForSurface(browser, surface, options.timeoutMs);
    }

    const surfaces = [];
    for (const surface of SURFACES) {
      const page = await waitForSurface(browser, surface, options.timeoutMs);
      surfaces.push(await inspectPage(page, surface, options));
    }
    const receipt = {
      schema: 'squidrun.build1b.window_capture.v0',
      capturedAt: new Date().toISOString(),
      head,
      expectedCommit: options.expectCommit,
      cdpPort: options.cdpPort,
      titlePrefix: options.titlePrefix,
      ok: surfaces.length === SURFACES.length && surfaces.every((surface) => surface.ok),
      surfaces,
      diagnostics,
    };
    const receiptPath = path.join(options.artifactDir, 'window-capture-receipt.json');
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    return { ...receipt, receiptPath };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const result = await capture(options);
  console.log(JSON.stringify({
    ok: result.ok,
    receiptPath: result.receiptPath,
    surfaces: result.surfaces.map((surface) => ({
      id: surface.id,
      ok: surface.ok,
      screenshot: surface.screenshot,
    })),
    diagnosticCount: result.diagnostics.length,
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[build-1b-window-capture] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  SURFACES,
  capture,
  identifySurface,
  normalizeUrlPath,
  parseArgs,
  verifyExpectedCommit,
};
