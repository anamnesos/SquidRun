#!/usr/bin/env node
/**
 * hm-smoke-runner: deterministic Playwright smoke runner for SquidRun.
 *
 * Artifact bundle:
 *   .squidrun/screenshots/smoke-runs/<run-id>/
 *   - screenshot.png
 *   - trace.zip
 *   - dom.html
 *   - diagnostics.json
 *   - summary.json
 *   - manifest.json
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
  resolveVisualRuntimeRoot,
  resolveReadyVisualUrl,
  writeCachedVisualUrl,
  buildVisualRunId,
} = require('./hm-visual-utils');

const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_SELECTOR_TIMEOUT_MS = 5000;
const DEFAULT_SETTLE_MS = 700;
const DEFAULT_WAIT_UNTIL = 'domcontentloaded';
const VALID_WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });

let playwrightModule = null;

function usage() {
  console.log('Usage: node hm-smoke-runner.js [run] [options]');
  console.log('Options:');
  console.log('  --url <url>                         Explicit URL (highest priority)');
  console.log('  --project-path <path>               Project root (default: active/cwd)');
  console.log('  --route <path>                      Route appended to resolved URL');
  console.log('  --require-selector <css>            Required selector (repeatable)');
  console.log('  --timeout <ms>                      Navigation/capture timeout (default: 25000)');
  console.log('  --ready-timeout <ms>                URL readiness timeout (default: 20000)');
  console.log('  --poll-ms <ms>                      URL readiness poll interval (default: 500)');
  console.log('  --selector-timeout <ms>             Per required-selector timeout (default: 5000)');
  console.log('  --wait-until <state>                load|domcontentloaded|networkidle|commit');
  console.log('  --settle-ms <ms>                    Extra wait before checks (default: 700)');
  console.log('  --viewport <WxH>                    Example: 1440x900');
  console.log('  --full-page                         Capture full-page screenshot');
  console.log('  --headed                            Launch browser headed');
  console.log('  --run-id <id>                       Explicit run id');
  console.log('  --label <name>                      Run id label (default: smoke)');
  console.log('  --artifact-root <path>              Override artifact root');
  console.log('  --max-candidates <n>                Max URL candidates to probe');
  console.log('  --send-telegram [caption]           Send screenshot via Telegram');
  console.log('Examples:');
  console.log('  node hm-smoke-runner.js run --route /dashboard --require-selector "#app"');
  console.log('  node hm-smoke-runner.js --url http://localhost:3000 --send-telegram "Smoke result"');
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

    if (options.has(key)) {
      const existing = options.get(key);
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        options.set(key, [existing, value]);
      }
    } else {
      options.set(key, value);
    }
  }

  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options.has(key)) return fallback;
  const value = options.get(key);
  if (Array.isArray(value)) return value[value.length - 1];
  return value;
}

function getOptionList(options, key) {
  if (!options.has(key)) return [];
  const value = options.get(key);
  if (Array.isArray(value)) return value.slice();
  return [value];
}

function getOptionAlias(options, keys = [], fallback = null) {
  for (const key of keys) {
    if (options.has(key)) {
      return getOption(options, key, fallback);
    }
  }
  return fallback;
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

function ensureRunId(value, label = 'smoke') {
  const explicit = asString(value, '');
  if (explicit) return explicit;
  return buildVisualRunId(label);
}

function readPlaywright() {
  if (playwrightModule) return playwrightModule;
  try {
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

function normalizePageError(err) {
  return {
    type: 'pageerror',
    text: err.message || 'Unknown page error',
    stack: err.stack || null,
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
  const request = res.request();
  return {
    kind: 'http_error',
    url: res.url(),
    status: res.status(),
    statusText: res.statusText(),
    method: request?.method ? request.method() : null,
    resourceType: request?.resourceType ? request.resourceType() : null,
    timestamp: new Date().toISOString(),
  };
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildArtifactLayout(options) {
  const artifactRoot = asString(options.artifactRoot, '')
    ? path.resolve(asString(options.artifactRoot, ''))
    : path.join(options.runtimeRoot, 'screenshots', 'smoke-runs');
  const runId = ensureRunId(options.runId, options.label || 'smoke');
  const runDir = path.join(artifactRoot, runId);
  ensureDir(runDir);
  return {
    artifactRoot,
    runId,
    runDir,
    screenshotPath: path.join(runDir, 'screenshot.png'),
    tracePath: path.join(runDir, 'trace.zip'),
    domPath: path.join(runDir, 'dom.html'),
    diagnosticsPath: path.join(runDir, 'diagnostics.json'),
    summaryPath: path.join(runDir, 'summary.json'),
    manifestPath: path.join(runDir, 'manifest.json'),
  };
}

function buildHardFailureStore() {
  const list = [];
  return {
    list,
    add(code, message, details = null) {
      list.push({
        code: asString(code, 'hard_failure'),
        message: asString(message, 'Smoke run hard failure'),
        details: details && typeof details === 'object' ? details : null,
      });
    },
  };
}

function buildDefaultTelegramCaption(summary) {
  return [
    'SquidRun smoke run',
    `Status: ${summary.ok ? 'PASS' : 'FAIL'}`,
    `URL: ${summary.url || 'unresolved'}`,
    `Hard failures: ${summary.hardFailureCount}`,
    `Run: ${summary.runId}`,
  ].join('\n');
}

function collectRunOptions(options) {
  const requireSelectorValues = getOptionList(options, 'require-selector');
  const requireSelectors = requireSelectorValues
    .map((value) => {
      if (value === true) {
        throw new Error('--require-selector expects a selector value');
      }
      return asString(value, '');
    })
    .filter(Boolean);

  const projectPath = resolveProjectPath({
    projectPath: asString(getOption(options, 'project-path', ''), '')
      || asString(getOption(options, 'project-root', ''), ''),
  });
  const runtimeRoot = resolveVisualRuntimeRoot({ projectPath });
  const explicitUrl = asString(getOptionAlias(options, ['url', 'target-url'], ''), '');
  const timeoutRaw = getOptionAlias(options, ['timeout', 'timeout-ms'], DEFAULT_TIMEOUT_MS);
  const readyTimeoutRaw = getOptionAlias(options, ['ready-timeout', 'ready-timeout-ms'], DEFAULT_READY_TIMEOUT_MS);
  const selectorTimeoutRaw = getOptionAlias(options, ['selector-timeout', 'selector-timeout-ms'], DEFAULT_SELECTOR_TIMEOUT_MS);
  const headed = options.has('headed')
    ? true
    : (options.has('headless') ? false : false);

  return {
    projectPath,
    runtimeRoot,
    explicitUrl,
    route: asString(getOption(options, 'route', '/'), '/'),
    requireSelectors,
    timeoutMs: asPositiveInt(timeoutRaw, DEFAULT_TIMEOUT_MS),
    readyTimeoutMs: asPositiveInt(readyTimeoutRaw, DEFAULT_READY_TIMEOUT_MS),
    pollMs: asPositiveInt(getOption(options, 'poll-ms', DEFAULT_POLL_MS), DEFAULT_POLL_MS),
    selectorTimeoutMs: asPositiveInt(selectorTimeoutRaw, DEFAULT_SELECTOR_TIMEOUT_MS),
    settleMs: asPositiveInt(getOption(options, 'settle-ms', DEFAULT_SETTLE_MS), DEFAULT_SETTLE_MS),
    waitUntil: normalizeWaitUntil(getOption(options, 'wait-until', DEFAULT_WAIT_UNTIL)),
    viewport: parseViewport(getOption(options, 'viewport', '')),
    fullPage: options.has('full-page'),
    headed,
    runId: asString(getOption(options, 'run-id', ''), ''),
    label: asString(getOption(options, 'label', 'smoke'), 'smoke'),
    artifactRoot: asString(getOption(options, 'artifact-root', ''), ''),
    maxCandidates: asPositiveInt(getOption(options, 'max-candidates', 8), 8),
    telegramRequested: options.has('send-telegram'),
    telegramCaptionRaw: getOption(options, 'send-telegram', ''),
    senderRole: asString(getOption(options, 'sender-role', ''), ''),
    triggerReason: asString(getOption(options, 'trigger-reason', ''), ''),
    triggerMessage: asString(getOption(options, 'message', ''), ''),
    sessionId: asString(getOption(options, 'session-id', ''), ''),
  };
}

function fileOrNull(filePath) {
  return fs.existsSync(filePath) ? filePath : null;
}

async function runSmoke(options) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const failures = buildHardFailureStore();
  const layout = buildArtifactLayout(options);

  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const httpErrors = [];
  const selectorChecks = [];
  const runtime = {
    title: null,
    finalUrl: null,
    traceStopError: null,
    navigationError: null,
    cacheWriteError: null,
    telegramError: null,
  };

  let resolution = null;
  let targetUrl = null;
  let source = null;

  try {
    resolution = await resolveReadyVisualUrl({
      projectPath: options.projectPath,
      url: options.explicitUrl,
      route: options.route,
      readyTimeoutMs: options.readyTimeoutMs,
      candidateTimeoutMs: Math.min(8000, options.readyTimeoutMs),
      pollMs: options.pollMs,
      maxCandidates: options.maxCandidates,
    });

    if (!resolution.ok) {
      failures.add('url_resolution_failed', `No reachable URL found (${resolution.reason || 'unknown_reason'})`, {
        route: options.route,
        checks: resolution.checks || [],
      });
    } else {
      targetUrl = resolution.url;
      source = resolution.source;
    }
  } catch (err) {
    failures.add('url_resolution_exception', err.message, {
      route: options.route,
    });
  }

  if (targetUrl) {
    let browser = null;
    let context = null;
    let page = null;
    try {
      const playwright = readPlaywright();
      browser = await playwright.chromium.launch({ headless: !options.headed });
      context = await browser.newContext({ viewport: options.viewport });
      page = await context.newPage();

      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(normalizeConsoleMessage(msg));
        }
      });
      page.on('pageerror', (err) => {
        pageErrors.push(normalizePageError(err));
      });
      page.on('requestfailed', (req) => {
        requestFailures.push(normalizeRequestFailed(req));
      });
      page.on('response', (res) => {
        if (res.status() >= 400) {
          httpErrors.push(normalizeHttpError(res));
        }
      });

      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
        title: `hm-smoke-runner:${layout.runId}`,
      });

      try {
        await page.goto(targetUrl, { waitUntil: options.waitUntil, timeout: options.timeoutMs });
        await page.waitForLoadState('domcontentloaded', { timeout: options.timeoutMs }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: Math.min(options.timeoutMs, 10000) }).catch(() => {});
        if (options.settleMs > 0) {
          await page.waitForTimeout(options.settleMs);
        }

        for (const selector of options.requireSelectors) {
          const check = {
            selector,
            ok: false,
            error: null,
            timestamp: new Date().toISOString(),
          };
          try {
            await page.waitForSelector(selector, {
              state: 'attached',
              timeout: options.selectorTimeoutMs,
            });
            check.ok = true;
          } catch (err) {
            check.error = err.message || 'selector_not_found';
            failures.add('required_selector_missing', `Required selector not found: ${selector}`, {
              selector,
              error: check.error,
            });
          }
          selectorChecks.push(check);
        }

        await page.screenshot({
          path: layout.screenshotPath,
          fullPage: options.fullPage,
          timeout: options.timeoutMs,
        });
        fs.writeFileSync(layout.domPath, await page.content(), 'utf8');
        runtime.title = await page.title().catch(() => null);
        runtime.finalUrl = page.url();
      } catch (err) {
        runtime.navigationError = err.message;
        failures.add('navigation_failed', err.message, {
          url: targetUrl,
        });
      } finally {
        try {
          await context.tracing.stop({ path: layout.tracePath });
        } catch (err) {
          runtime.traceStopError = err.message;
          failures.add('trace_capture_failed', err.message);
        }
      }
    } catch (err) {
      failures.add('playwright_runtime_failed', err.message);
    } finally {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  if (consoleErrors.length > 0) {
    failures.add('console_errors_detected', `${consoleErrors.length} console error event(s) captured`);
  }
  if (pageErrors.length > 0) {
    failures.add('page_errors_detected', `${pageErrors.length} page error event(s) captured`);
  }
  if (requestFailures.length > 0) {
    failures.add('request_failures_detected', `${requestFailures.length} requestfailed event(s) captured`);
  }
  if (httpErrors.length > 0) {
    failures.add('http_errors_detected', `${httpErrors.length} HTTP >= 400 response(s) captured`);
  }

  if (targetUrl) {
    const cacheResult = writeCachedVisualUrl(options.projectPath, targetUrl, {
      source: source || 'unknown',
      lastRunId: layout.runId,
    }, { projectPath: options.projectPath });
    if (!cacheResult.ok) {
      runtime.cacheWriteError = cacheResult.error || 'cache_write_failed';
    }
  }

  const finishedAt = new Date().toISOString();
  const finishedAtMs = Date.now();
  const missingSelectors = selectorChecks.filter((item) => !item.ok);

  const diagnostics = {
    runId: layout.runId,
    startedAt,
    finishedAt,
    elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
    options: {
      ...options,
      explicitUrl: options.explicitUrl || null,
      telegramCaptionRaw: asString(options.telegramCaptionRaw, '') || null,
    },
    resolution: resolution || null,
    source: source || null,
    url: targetUrl || null,
    runtime,
    signals: {
      consoleErrors,
      pageErrors,
      requestFailures,
      httpErrors,
    },
    selectorChecks,
    hardFailures: failures.list,
  };

  const summary = {
    ok: failures.list.length === 0,
    runId: layout.runId,
    runDir: layout.runDir,
    artifactRoot: layout.artifactRoot,
    projectPath: options.projectPath,
    route: options.route,
    source: source || null,
    url: runtime.finalUrl || targetUrl || null,
    title: runtime.title,
    startedAt,
    finishedAt,
    elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
    screenshotPath: fileOrNull(layout.screenshotPath),
    tracePath: fileOrNull(layout.tracePath),
    domPath: fileOrNull(layout.domPath),
    diagnosticsPath: layout.diagnosticsPath,
    summaryPath: layout.summaryPath,
    manifestPath: layout.manifestPath,
    consoleErrorCount: consoleErrors.length,
    pageErrorCount: pageErrors.length,
    requestFailureCount: requestFailures.length,
    httpErrorCount: httpErrors.length,
    requiredSelectorCount: options.requireSelectors.length,
    missingSelectorCount: missingSelectors.length,
    hardFailureCount: failures.list.length,
    hardFailures: failures.list.slice(),
    readinessChecks: Array.isArray(resolution?.checks) ? resolution.checks : [],
    telegram: null,
  };

  if (options.telegramRequested) {
    if (!summary.screenshotPath) {
      runtime.telegramError = 'screenshot_missing_for_telegram';
      failures.add('telegram_send_failed', 'Cannot send Telegram photo without screenshot');
      summary.telegram = {
        ok: false,
        error: runtime.telegramError,
      };
    } else {
      const caption = asString(options.telegramCaptionRaw, '') || buildDefaultTelegramCaption(summary);
      const result = await sendTelegramPhoto(summary.screenshotPath, caption, process.env, {
        senderRole: 'builder',
        targetRole: 'user',
      });
      if (!result.ok) {
        runtime.telegramError = result.error || 'telegram_send_failed';
        failures.add('telegram_send_failed', runtime.telegramError);
        summary.telegram = {
          ok: false,
          error: runtime.telegramError,
          statusCode: result.statusCode || null,
        };
      } else {
        summary.telegram = {
          ok: true,
          chatId: result.chatId || null,
          messageId: result.messageId || null,
          statusCode: result.statusCode || null,
        };
      }
    }
  }

  summary.hardFailureCount = failures.list.length;
  summary.hardFailures = failures.list.slice();
  summary.ok = failures.list.length === 0;
  diagnostics.runtime = runtime;
  diagnostics.hardFailures = failures.list.slice();

  writeJson(layout.diagnosticsPath, diagnostics);
  writeJson(layout.summaryPath, summary);
  writeJson(layout.manifestPath, {
    runId: layout.runId,
    generatedAt: finishedAt,
    runDir: layout.runDir,
    files: {
      screenshot: summary.screenshotPath,
      trace: summary.tracePath,
      dom: summary.domPath,
      diagnostics: layout.diagnosticsPath,
      summary: layout.summaryPath,
      manifest: layout.manifestPath,
    },
    counts: {
      consoleErrors: summary.consoleErrorCount,
      pageErrors: summary.pageErrorCount,
      requestFailures: summary.requestFailureCount,
      httpErrors: summary.httpErrorCount,
      requiredSelectors: summary.requiredSelectorCount,
      missingSelectors: summary.missingSelectorCount,
      hardFailures: summary.hardFailureCount,
    },
  });

  return summary;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const { positional, options } = parseArgs(argv);
  const command = positional.length > 0 ? asString(positional[0], '').toLowerCase() : 'run';
  if (!['run', 'smoke'].includes(command)) {
    usage();
    process.exit(1);
  }

  const runOptions = collectRunOptions(options);
  const summary = await runSmoke(runOptions);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    const output = {
      ok: false,
      error: err.message,
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  getOption,
  getOptionList,
  parseViewport,
  normalizeWaitUntil,
  collectRunOptions,
  buildArtifactLayout,
  runSmoke,
  main,
};
