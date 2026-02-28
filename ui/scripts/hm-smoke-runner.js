#!/usr/bin/env node
/**
 * hm-smoke-runner: deterministic Playwright smoke runner for SquidRun.
 *
 * Artifact bundle:
 *   .squidrun/screenshots/smoke-runs/<run-id>/
 *   - screenshot.png
 *   - trace.zip
 *   - dom.html
 *   - aria-snapshot.json
 *   - axe-report.json
 *   - dom-summary.json
 *   - link-checks.json
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
const DEFAULT_LINK_TIMEOUT_MS = 4000;
const DEFAULT_MAX_LINKS = 25;
const DEFAULT_AXE_MAX_VIOLATIONS = 0;
const DEFAULT_MAX_BROKEN_LINKS = 0;
const DEFAULT_MIN_BODY_TEXT_CHARS = 0;
const DEFAULT_WAIT_UNTIL = 'domcontentloaded';
const VALID_WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });

let playwrightModule = null;
let axeSourceCache = null;

function usage() {
  console.log('Usage: node hm-smoke-runner.js [run] [options]');
  console.log('Options:');
  console.log('  --url <url>                         Explicit URL (highest priority)');
  console.log('  --project-path <path>               Project root (default: active/cwd)');
  console.log('  --route <path>                      Route appended to resolved URL');
  console.log('  --require-selector <css>            Required selector (repeatable)');
  console.log('  --require-text <text>               Required body text snippet (repeatable)');
  console.log('  --timeout <ms>                      Navigation/capture timeout (default: 25000)');
  console.log('  --ready-timeout <ms>                URL readiness timeout (default: 20000)');
  console.log('  --poll-ms <ms>                      URL readiness poll interval (default: 500)');
  console.log('  --selector-timeout <ms>             Per required-selector timeout (default: 5000)');
  console.log('  --link-timeout-ms <ms>              Per-link validation timeout (default: 4000)');
  console.log('  --max-links <n>                     Max links to validate (default: 25)');
  console.log('  --max-broken-links <n>              Allowed broken links before failure (default: 0)');
  console.log('  --min-body-text-chars <n>           Minimum body text chars before failure (default: 0)');
  console.log('  --axe-max-violations <n>            Allowed axe violations before failure (default: 0)');
  console.log('  --no-axe                            Disable axe-core accessibility scan');
  console.log('  --no-validate-links                 Disable anchor broken-link validation');
  console.log('  --include-external-links            Include off-origin links in validation');
  console.log('  --content-case-sensitive            Required text checks become case sensitive');
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
  console.log('  node hm-smoke-runner.js run --route /dashboard --require-selector "#app" --require-text "Dashboard"');
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

function readAxeSource() {
  if (axeSourceCache) return axeSourceCache;
  try {
    const axePath = require.resolve('axe-core/axe.min.js');
    axeSourceCache = fs.readFileSync(axePath, 'utf8');
    return axeSourceCache;
  } catch (err) {
    throw new Error(`axe-core is not installed. Install from ui/: npm install axe-core --save\nOriginal error: ${err.message}`);
  }
}

function resolveBooleanFlag(options, { enableKey, disableKey, defaultValue = false }) {
  if (disableKey && options.has(disableKey)) return false;
  if (enableKey && options.has(enableKey)) return true;
  return Boolean(defaultValue);
}

function asNonNegativeInt(value, fallback = 0) {
  const numeric = Number.parseInt(String(value), 10);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.trunc(numeric);
}

function normalizeTextForMatch(value, caseSensitive = false) {
  const text = asString(value, '');
  if (caseSensitive) return text;
  return text.toLowerCase();
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

function simplifyAxeNode(node) {
  if (!node || typeof node !== 'object') return null;
  return {
    target: Array.isArray(node.target) ? node.target : [],
    html: asString(node.html, ''),
    impact: asString(node.impact, '') || null,
    failureSummary: asString(node.failureSummary, '') || null,
  };
}

function simplifyAxeViolation(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const nodes = Array.isArray(entry.nodes)
    ? entry.nodes.map(simplifyAxeNode).filter(Boolean)
    : [];
  return {
    id: asString(entry.id, 'unknown'),
    impact: asString(entry.impact, '') || null,
    description: asString(entry.description, '') || null,
    help: asString(entry.help, '') || null,
    helpUrl: asString(entry.helpUrl, '') || null,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    nodeCount: nodes.length,
    nodes,
  };
}

async function runAxeAudit(page) {
  const axeSource = readAxeSource();
  await page.addScriptTag({ content: axeSource });
  const raw = await page.evaluate(async () => {
    if (!window.axe || typeof window.axe.run !== 'function') {
      return { error: 'axe_not_available' };
    }
    return await window.axe.run(document, {
      resultTypes: ['violations', 'incomplete'],
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      },
    });
  });

  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      error: 'axe_invalid_output',
      passes: [],
      incomplete: [],
      violations: [],
    };
  }

  if (raw.error) {
    return {
      ok: false,
      error: asString(raw.error, 'axe_error'),
      passes: [],
      incomplete: [],
      violations: [],
    };
  }

  const violations = Array.isArray(raw.violations)
    ? raw.violations.map(simplifyAxeViolation).filter(Boolean)
    : [];
  const incomplete = Array.isArray(raw.incomplete)
    ? raw.incomplete.map(simplifyAxeViolation).filter(Boolean)
    : [];

  return {
    ok: true,
    url: asString(raw.url, '') || null,
    timestamp: asString(raw.timestamp, '') || null,
    violations,
    incomplete,
    violationCount: violations.length,
    incompleteCount: incomplete.length,
    passCount: Array.isArray(raw.passes) ? raw.passes.length : 0,
    inapplicableCount: Array.isArray(raw.inapplicable) ? raw.inapplicable.length : 0,
  };
}

async function collectDomSummary(page) {
  return await page.evaluate(() => {
    const textContent = (document.body?.innerText || '').trim();
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((node) => ({
      level: Number(String(node.tagName || '').replace(/[^0-9]/g, '')) || null,
      text: (node.textContent || '').trim().slice(0, 200),
    }));
    const links = Array.from(document.querySelectorAll('a[href]'));
    const images = Array.from(document.querySelectorAll('img'));
    const scripts = Array.from(document.querySelectorAll('script[src]'));

    return {
      title: (document.title || '').trim(),
      url: window.location.href,
      headingCount: headings.length,
      headings,
      landmarkCount: document.querySelectorAll('main,nav,header,footer,aside,[role]').length,
      formCount: document.querySelectorAll('form').length,
      buttonCount: document.querySelectorAll('button,[role=\"button\"]').length,
      inputCount: document.querySelectorAll('input,textarea,select').length,
      linkCount: links.length,
      imageCount: images.length,
      scriptSrcCount: scripts.length,
      bodyTextChars: textContent.length,
      bodyTextPreview: textContent.slice(0, 500),
      hasMain: Boolean(document.querySelector('main,[role=\"main\"]')),
      hasH1: Boolean(document.querySelector('h1')),
    };
  });
}

function resolveHttpUrl(candidate, baseUrl) {
  const raw = asString(candidate, '');
  if (!raw) return null;
  try {
    const resolved = new URL(raw, baseUrl);
    if (!/^https?:$/i.test(resolved.protocol)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function hasSameOrigin(baseUrl, candidateUrl) {
  try {
    const base = new URL(baseUrl);
    const target = new URL(candidateUrl);
    return base.origin.toLowerCase() === target.origin.toLowerCase();
  } catch {
    return false;
  }
}

async function probeLinkStatus(url, timeoutMs = DEFAULT_LINK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  const request = async (method) => await fetch(url, {
    method,
    redirect: 'follow',
    signal: controller.signal,
  });

  try {
    let response = await request('HEAD');
    if (response.status === 405 || response.status === 501) {
      response = await request('GET');
    }
    return {
      ok: response.status < 400,
      statusCode: response.status,
      statusText: response.statusText || null,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      statusText: null,
      error: err?.message || 'request_failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function collectAndValidateLinks(page, baseUrl, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const includeExternalLinks = opts.includeExternalLinks === true;
  const maxLinks = asNonNegativeInt(opts.maxLinks, DEFAULT_MAX_LINKS);
  const linkTimeoutMs = asPositiveInt(opts.linkTimeoutMs, DEFAULT_LINK_TIMEOUT_MS);

  const discovered = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
      href: anchor.getAttribute('href') || '',
      text: (anchor.textContent || '').trim().slice(0, 180),
      rel: anchor.getAttribute('rel') || '',
      target: anchor.getAttribute('target') || '',
    }));
  });

  const normalized = [];
  const seen = new Set();
  for (const entry of discovered) {
    const url = resolveHttpUrl(entry?.href, baseUrl);
    if (!url) continue;
    const isExternal = !hasSameOrigin(baseUrl, url);
    if (!includeExternalLinks && isExternal) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      url,
      href: asString(entry?.href, ''),
      text: asString(entry?.text, ''),
      rel: asString(entry?.rel, ''),
      target: asString(entry?.target, ''),
      isExternal,
    });
  }

  const limit = maxLinks > 0 ? Math.min(maxLinks, normalized.length) : normalized.length;
  const checked = [];
  for (let index = 0; index < limit; index += 1) {
    const link = normalized[index];
    const result = await probeLinkStatus(link.url, linkTimeoutMs);
    checked.push({
      ...link,
      statusCode: result.statusCode,
      statusText: result.statusText,
      ok: result.ok,
      error: result.error,
    });
  }

  const broken = checked.filter((item) => !item.ok);
  return {
    totalDiscovered: discovered.length,
    candidateCount: normalized.length,
    checkedCount: checked.length,
    skippedCount: Math.max(0, normalized.length - checked.length),
    brokenCount: broken.length,
    brokenLinks: broken,
    checkedLinks: checked,
    includeExternalLinks,
    maxLinks,
    linkTimeoutMs,
  };
}

function buildRequiredTextChecks(bodyText, requiredTexts = [], caseSensitive = false) {
  const normalizedBody = normalizeTextForMatch(bodyText, caseSensitive);
  return requiredTexts.map((text) => {
    const raw = asString(text, '');
    const normalizedNeedle = normalizeTextForMatch(raw, caseSensitive);
    const ok = normalizedNeedle ? normalizedBody.includes(normalizedNeedle) : false;
    return {
      text: raw,
      ok,
      caseSensitive,
      timestamp: new Date().toISOString(),
    };
  });
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
    ariaPath: path.join(runDir, 'aria-snapshot.json'),
    axePath: path.join(runDir, 'axe-report.json'),
    domSummaryPath: path.join(runDir, 'dom-summary.json'),
    linkCheckPath: path.join(runDir, 'link-checks.json'),
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
    `A11y violations: ${summary.axeViolationCount || 0}`,
    `Broken links: ${summary.brokenLinkCount || 0}`,
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
  const requireTextValues = getOptionList(options, 'require-text');
  const requireTexts = requireTextValues
    .map((value) => {
      if (value === true) {
        throw new Error('--require-text expects a text value');
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
  const linkTimeoutRaw = getOptionAlias(options, ['link-timeout', 'link-timeout-ms'], DEFAULT_LINK_TIMEOUT_MS);
  const headed = options.has('headed')
    ? true
    : (options.has('headless') ? false : false);
  const collectA11y = resolveBooleanFlag(options, {
    enableKey: 'axe',
    disableKey: 'no-axe',
    defaultValue: true,
  });
  const validateLinks = resolveBooleanFlag(options, {
    enableKey: 'validate-links',
    disableKey: 'no-validate-links',
    defaultValue: true,
  });

  return {
    projectPath,
    runtimeRoot,
    explicitUrl,
    route: asString(getOption(options, 'route', '/'), '/'),
    requireSelectors,
    requireTexts,
    timeoutMs: asPositiveInt(timeoutRaw, DEFAULT_TIMEOUT_MS),
    readyTimeoutMs: asPositiveInt(readyTimeoutRaw, DEFAULT_READY_TIMEOUT_MS),
    pollMs: asPositiveInt(getOption(options, 'poll-ms', DEFAULT_POLL_MS), DEFAULT_POLL_MS),
    selectorTimeoutMs: asPositiveInt(selectorTimeoutRaw, DEFAULT_SELECTOR_TIMEOUT_MS),
    linkTimeoutMs: asPositiveInt(linkTimeoutRaw, DEFAULT_LINK_TIMEOUT_MS),
    settleMs: asPositiveInt(getOption(options, 'settle-ms', DEFAULT_SETTLE_MS), DEFAULT_SETTLE_MS),
    waitUntil: normalizeWaitUntil(getOption(options, 'wait-until', DEFAULT_WAIT_UNTIL)),
    viewport: parseViewport(getOption(options, 'viewport', '')),
    fullPage: options.has('full-page'),
    headed,
    runId: asString(getOption(options, 'run-id', ''), ''),
    label: asString(getOption(options, 'label', 'smoke'), 'smoke'),
    artifactRoot: asString(getOption(options, 'artifact-root', ''), ''),
    maxCandidates: asPositiveInt(getOption(options, 'max-candidates', 8), 8),
    maxLinks: asNonNegativeInt(getOption(options, 'max-links', DEFAULT_MAX_LINKS), DEFAULT_MAX_LINKS),
    maxBrokenLinks: asNonNegativeInt(getOption(options, 'max-broken-links', DEFAULT_MAX_BROKEN_LINKS), DEFAULT_MAX_BROKEN_LINKS),
    axeMaxViolations: asNonNegativeInt(getOption(options, 'axe-max-violations', DEFAULT_AXE_MAX_VIOLATIONS), DEFAULT_AXE_MAX_VIOLATIONS),
    minBodyTextChars: asNonNegativeInt(getOption(options, 'min-body-text-chars', DEFAULT_MIN_BODY_TEXT_CHARS), DEFAULT_MIN_BODY_TEXT_CHARS),
    collectA11y,
    validateLinks,
    includeExternalLinks: options.has('include-external-links'),
    contentCaseSensitive: options.has('content-case-sensitive'),
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
  const textChecks = [];
  let ariaSnapshot = null;
  let axeAudit = null;
  let domSummary = null;
  let linkValidation = null;
  const runtime = {
    title: null,
    finalUrl: null,
    traceStopError: null,
    navigationError: null,
    cacheWriteError: null,
    telegramError: null,
    axeError: null,
    linkValidationError: null,
    ariaError: null,
    domSummaryError: null,
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
        const domContent = await page.content();
        fs.writeFileSync(layout.domPath, domContent, 'utf8');

        const bodyText = await page.evaluate(() => (document.body?.innerText || '').trim()).catch(() => '');
        if (Array.isArray(options.requireTexts) && options.requireTexts.length > 0) {
          const checks = buildRequiredTextChecks(bodyText, options.requireTexts, options.contentCaseSensitive === true);
          textChecks.push(...checks);
          for (const check of checks) {
            if (!check.ok) {
              failures.add('required_text_missing', `Required text not found: "${check.text}"`, {
                text: check.text,
                caseSensitive: check.caseSensitive,
              });
            }
          }
        }

        domSummary = await collectDomSummary(page).catch((err) => {
          runtime.domSummaryError = err.message;
          return null;
        });
        if (options.minBodyTextChars > 0) {
          const bodyTextChars = Number(domSummary?.bodyTextChars || bodyText.length || 0);
          if (bodyTextChars < options.minBodyTextChars) {
            failures.add(
              'insufficient_body_content',
              `Body text chars ${bodyTextChars} below minimum ${options.minBodyTextChars}`,
              { bodyTextChars, minBodyTextChars: options.minBodyTextChars }
            );
          }
        }

        if (options.collectA11y) {
          ariaSnapshot = await collectAriaSnapshot(page).catch((err) => {
            runtime.ariaError = err.message;
            return null;
          });
          axeAudit = await runAxeAudit(page).catch((err) => {
            runtime.axeError = err.message;
            return {
              ok: false,
              error: err.message,
              violations: [],
              incomplete: [],
              violationCount: 0,
              incompleteCount: 0,
              passCount: 0,
              inapplicableCount: 0,
            };
          });

          if (!axeAudit?.ok) {
            failures.add('axe_audit_failed', `axe-core audit failed (${axeAudit?.error || 'unknown_error'})`);
          } else if ((axeAudit?.violationCount || 0) > options.axeMaxViolations) {
            failures.add(
              'axe_violations_detected',
              `axe violations ${axeAudit.violationCount} exceed allowed ${options.axeMaxViolations}`,
              {
                violationCount: axeAudit.violationCount,
                axeMaxViolations: options.axeMaxViolations,
              }
            );
          }
        }

        if (options.validateLinks) {
          linkValidation = await collectAndValidateLinks(page, targetUrl, {
            includeExternalLinks: options.includeExternalLinks,
            maxLinks: options.maxLinks,
            linkTimeoutMs: options.linkTimeoutMs,
          }).catch((err) => {
            runtime.linkValidationError = err.message;
            return null;
          });

          if (!linkValidation) {
            failures.add('link_validation_failed', runtime.linkValidationError || 'link_validation_failed');
          } else if ((linkValidation.brokenCount || 0) > options.maxBrokenLinks) {
            failures.add(
              'broken_links_detected',
              `Broken links ${linkValidation.brokenCount} exceed allowed ${options.maxBrokenLinks}`,
              {
                brokenCount: linkValidation.brokenCount,
                maxBrokenLinks: options.maxBrokenLinks,
              }
            );
          }
        }

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
  const missingTexts = textChecks.filter((item) => !item.ok);

  if (ariaSnapshot !== null) {
    writeJson(layout.ariaPath, ariaSnapshot);
  }
  if (axeAudit !== null) {
    writeJson(layout.axePath, axeAudit);
  }
  if (domSummary !== null) {
    writeJson(layout.domSummaryPath, domSummary);
  }
  if (linkValidation !== null) {
    writeJson(layout.linkCheckPath, linkValidation);
  }

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
      textChecks,
      ariaSnapshot,
      axeAudit,
      domSummary,
      linkValidation,
    },
    selectorChecks,
    textChecks,
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
    ariaPath: fileOrNull(layout.ariaPath),
    axePath: fileOrNull(layout.axePath),
    domSummaryPath: fileOrNull(layout.domSummaryPath),
    linkCheckPath: fileOrNull(layout.linkCheckPath),
    diagnosticsPath: layout.diagnosticsPath,
    summaryPath: layout.summaryPath,
    manifestPath: layout.manifestPath,
    consoleErrorCount: consoleErrors.length,
    pageErrorCount: pageErrors.length,
    requestFailureCount: requestFailures.length,
    httpErrorCount: httpErrors.length,
    requiredSelectorCount: options.requireSelectors.length,
    missingSelectorCount: missingSelectors.length,
    requiredTextCount: options.requireTexts.length,
    missingTextCount: missingTexts.length,
    axeViolationCount: Number(axeAudit?.violationCount || 0),
    axeIncompleteCount: Number(axeAudit?.incompleteCount || 0),
    brokenLinkCount: Number(linkValidation?.brokenCount || 0),
    checkedLinkCount: Number(linkValidation?.checkedCount || 0),
    bodyTextChars: Number(domSummary?.bodyTextChars || 0),
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
      aria: summary.ariaPath,
      axe: summary.axePath,
      domSummary: summary.domSummaryPath,
      linkChecks: summary.linkCheckPath,
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
      requiredTexts: summary.requiredTextCount,
      missingTexts: summary.missingTextCount,
      axeViolations: summary.axeViolationCount,
      axeIncomplete: summary.axeIncompleteCount,
      checkedLinks: summary.checkedLinkCount,
      brokenLinks: summary.brokenLinkCount,
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
