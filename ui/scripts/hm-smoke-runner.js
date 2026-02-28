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
const crypto = require('crypto');
const { PNG } = require('pngjs');
const {
  sendTelegramPhoto,
} = require('./hm-telegram');
const {
  asString,
  asPositiveInt,
  ensureDir,
  applyRouteToUrl,
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
const DEFAULT_MAX_DIFF_PIXELS = -1;
const DEFAULT_PIXEL_DIFF_THRESHOLD = 0.1;
const DEFAULT_LIGHTHOUSE_TIMEOUT_MS = 45000;
const DEFAULT_LIGHTHOUSE_MIN_SCORE = -1;
const DEFAULT_GATE_PROFILE = 'per-cycle';
const VALID_GATE_PROFILE = new Set(['per-cycle', 'nightly', 'release']);
const DEFAULT_WAIT_UNTIL = 'domcontentloaded';
const VALID_WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });

let playwrightModule = null;
let axeSourceCache = null;
let pixelmatchCache = null;
let lighthouseCache = null;
let chromeLauncherCache = null;

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
  console.log('  --max-diff-pixels <n>               Fail when diff pixels exceed threshold (default: disabled)');
  console.log('  --diff-threshold <0..1>             pixelmatch sensitivity threshold (default: 0.1)');
  console.log('  --baseline-key <key>                Override baseline key used for before/after diff');
  console.log('  --no-diff                           Disable before/after pixel diff generation');
  console.log('  --no-update-baseline                Do not update baseline screenshot on pass');
  console.log('  --update-baseline-always            Update baseline even when run fails');
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
  console.log('  --no-generate-spec                  Disable draft Playwright spec generation on pass');
  console.log('  --spec-dir <path>                   Directory for generated spec drafts');
  console.log('  --spec-out <path>                   Explicit generated spec output file path');
  console.log('  --spec-name <name>                  Override generated spec filename (without extension)');
  console.log('  --no-perf                           Disable perf capture (web-vitals + lighthouse)');
  console.log('  --no-web-vitals                     Disable web-vitals capture');
  console.log('  --no-lighthouse                     Disable Lighthouse capture');
  console.log('  --perf-route <path>                 Additional key route for perf capture (repeatable)');
  console.log('  --lighthouse-min-score <0..100>     Fail when Lighthouse perf score drops below threshold');
  console.log('  --lighthouse-timeout-ms <ms>        Lighthouse run timeout (default: 45000)');
  console.log('  --gate-profile <profile>            per-cycle|nightly|release (default: per-cycle)');
  console.log('  --force-firefox-gate                Run Firefox gate even outside nightly/release');
  console.log('  --no-browser-matrix                 Disable additional browser gate runs');
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

async function readPixelmatch() {
  if (pixelmatchCache) return pixelmatchCache;
  try {
    const mod = await import('pixelmatch');
    const resolved = typeof mod?.default === 'function'
      ? mod.default
      : (typeof mod === 'function' ? mod : null);
    if (typeof resolved !== 'function') {
      throw new Error('pixelmatch_export_invalid');
    }
    pixelmatchCache = resolved;
    return resolved;
  } catch (err) {
    throw new Error(`pixelmatch is not available. Install from ui/: npm install pixelmatch --save\nOriginal error: ${err.message}`);
  }
}

async function readLighthouse() {
  if (lighthouseCache) return lighthouseCache;
  try {
    const mod = await import('lighthouse');
    const resolved = (typeof mod?.default === 'function')
      ? mod.default
      : (typeof mod?.lighthouse === 'function' ? mod.lighthouse : null);
    if (typeof resolved !== 'function') {
      throw new Error('lighthouse_export_invalid');
    }
    lighthouseCache = resolved;
    return resolved;
  } catch (err) {
    throw new Error(`lighthouse is not available. Install from ui/: npm install lighthouse --save\nOriginal error: ${err.message}`);
  }
}

function readChromeLauncher() {
  if (chromeLauncherCache) return chromeLauncherCache;
  try {
    chromeLauncherCache = require('chrome-launcher');
    return chromeLauncherCache;
  } catch (err) {
    throw new Error(`chrome-launcher is not available. Install from ui/: npm install chrome-launcher --save\nOriginal error: ${err.message}`);
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

function asFloatInRange(value, fallback = DEFAULT_PIXEL_DIFF_THRESHOLD, min = 0, max = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < min || numeric > max) return fallback;
  return numeric;
}

function asNullableFloatInRange(value, fallback = null, min = 0, max = 100) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < min || numeric > max) return fallback;
  return numeric;
}

function normalizeGateProfile(value, fallback = DEFAULT_GATE_PROFILE) {
  const token = asString(value, fallback).toLowerCase();
  if (VALID_GATE_PROFILE.has(token)) return token;
  return fallback;
}

function normalizeRouteToken(value) {
  const raw = asString(value, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return parsed.pathname || '/';
    } catch {
      return '';
    }
  }
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function shouldRunFirefoxGate(options = {}) {
  if (!options || typeof options !== 'object') return false;
  if (options.enableBrowserMatrix === false) return false;
  if (options.forceFirefoxGate === true) return true;
  const profile = normalizeGateProfile(options.gateProfile, DEFAULT_GATE_PROFILE);
  return profile === 'nightly' || profile === 'release';
}

function roundMetric(value, places = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sanitizeToken(value, fallback = 'default') {
  const raw = asString(value, '');
  if (!raw) return fallback;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex').slice(0, 12);
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

function buildPerformanceTargets(options = {}, targetUrl = '') {
  const baseUrl = asString(targetUrl, '');
  if (!baseUrl) return [];

  const targets = [];
  const seen = new Set();
  const pushTarget = (route, url, source) => {
    const normalizedUrl = asString(url, '');
    if (!normalizedUrl) return;
    const key = normalizedUrl.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({
      route: normalizeRouteToken(route) || '/',
      url: normalizedUrl,
      source: asString(source, 'derived'),
    });
  };

  const routeFromOptions = normalizeRouteToken(options.route);
  let routeFromUrl = '/';
  try {
    const parsed = new URL(baseUrl);
    routeFromUrl = parsed.pathname || '/';
  } catch {
    // Fall back to root.
  }

  pushTarget(routeFromOptions || routeFromUrl, baseUrl, 'primary');
  const configuredRoutes = Array.isArray(options.perfRoutes) ? options.perfRoutes : [];
  for (const configuredRoute of configuredRoutes) {
    const route = normalizeRouteToken(configuredRoute);
    if (!route) continue;
    const resolved = applyRouteToUrl(baseUrl, route);
    pushTarget(route, resolved, 'perf-route');
  }
  return targets;
}

async function collectWebVitalsSnapshot(page) {
  return await page.evaluate(() => {
    const toNumber = (value) => (Number.isFinite(value) ? Number(value) : null);
    const nav = performance.getEntriesByType('navigation')[0];
    const paintEntries = performance.getEntriesByType('paint');
    const fcpEntry = paintEntries.find((entry) => entry.name === 'first-contentful-paint');
    const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
    const lcpEntry = lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1] : null;
    const clsEntries = performance.getEntriesByType('layout-shift');
    const cls = clsEntries.reduce((sum, entry) => {
      if (entry && entry.hadRecentInput === false && Number.isFinite(entry.value)) {
        return sum + entry.value;
      }
      return sum;
    }, 0);

    return {
      collectedAt: new Date().toISOString(),
      metrics: {
        ttfbMs: nav ? toNumber(nav.responseStart) : null,
        domContentLoadedMs: nav ? toNumber(nav.domContentLoadedEventEnd) : null,
        loadEventMs: nav ? toNumber(nav.loadEventEnd) : null,
        fcpMs: fcpEntry ? toNumber(fcpEntry.startTime) : null,
        lcpMs: lcpEntry ? toNumber(lcpEntry.startTime) : null,
        cls: toNumber(cls),
      },
    };
  });
}

function averageMetric(entries = [], key) {
  const values = entries
    .map((entry) => Number(entry?.metrics?.[key]))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return roundMetric(total / values.length, key === 'cls' ? 4 : 2);
}

async function runWebVitalsCapture({ playwright, options, targets }) {
  const result = {
    enabled: options.collectWebVitals === true,
    status: 'disabled',
    totalRoutes: targets.length,
    okRoutes: 0,
    failedRoutes: 0,
    runs: [],
    averages: {
      ttfbMs: null,
      domContentLoadedMs: null,
      loadEventMs: null,
      fcpMs: null,
      lcpMs: null,
      cls: null,
    },
    error: null,
  };
  if (!result.enabled) return result;
  if (!Array.isArray(targets) || targets.length < 1) {
    result.status = 'no_targets';
    return result;
  }

  let browser = null;
  let context = null;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: options.viewport });
    for (const target of targets) {
      const runEntry = {
        route: target.route,
        url: target.url,
        source: target.source,
        ok: false,
        error: null,
        finalUrl: null,
        title: null,
        metrics: null,
      };
      let page = null;
      try {
        page = await context.newPage();
        await page.goto(target.url, {
          waitUntil: options.waitUntil,
          timeout: options.timeoutMs,
        });
        await page.waitForLoadState('networkidle', {
          timeout: Math.min(options.timeoutMs, 10000),
        }).catch(() => {});
        if (options.settleMs > 0) {
          await page.waitForTimeout(options.settleMs);
        }
        const snapshot = await collectWebVitalsSnapshot(page);
        runEntry.metrics = snapshot?.metrics || null;
        runEntry.finalUrl = page.url();
        runEntry.title = await page.title().catch(() => null);
        runEntry.ok = true;
      } catch (err) {
        runEntry.error = err.message || 'web_vitals_capture_failed';
      } finally {
        if (page) await page.close().catch(() => {});
      }
      result.runs.push(runEntry);
    }
  } catch (err) {
    result.error = err.message || 'web_vitals_runtime_failed';
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  const successful = result.runs.filter((entry) => entry.ok);
  result.okRoutes = successful.length;
  result.failedRoutes = Math.max(0, result.runs.length - successful.length);
  result.averages = {
    ttfbMs: averageMetric(successful, 'ttfbMs'),
    domContentLoadedMs: averageMetric(successful, 'domContentLoadedMs'),
    loadEventMs: averageMetric(successful, 'loadEventMs'),
    fcpMs: averageMetric(successful, 'fcpMs'),
    lcpMs: averageMetric(successful, 'lcpMs'),
    cls: averageMetric(successful, 'cls'),
  };
  if (result.error) {
    result.status = 'error';
  } else if (result.okRoutes === result.totalRoutes) {
    result.status = 'ok';
  } else if (result.okRoutes > 0) {
    result.status = 'partial';
  } else {
    result.status = 'error';
    if (!result.error) result.error = 'web_vitals_all_routes_failed';
  }
  return result;
}

function extractLighthouseMetrics(lhr = {}) {
  const audits = lhr && typeof lhr === 'object' ? lhr.audits || {} : {};
  const read = (id, places = 2) => {
    const value = Number(audits?.[id]?.numericValue);
    return Number.isFinite(value) ? roundMetric(value, places) : null;
  };
  return {
    performanceScore: Number.isFinite(Number(lhr?.categories?.performance?.score))
      ? roundMetric(Number(lhr.categories.performance.score) * 100, 2)
      : null,
    firstContentfulPaintMs: read('first-contentful-paint'),
    largestContentfulPaintMs: read('largest-contentful-paint'),
    totalBlockingTimeMs: read('total-blocking-time'),
    cumulativeLayoutShift: read('cumulative-layout-shift', 4),
    speedIndexMs: read('speed-index'),
    interactiveMs: read('interactive'),
  };
}

function resolveChromiumExecutablePath(playwright) {
  try {
    if (playwright?.chromium && typeof playwright.chromium.executablePath === 'function') {
      const candidate = playwright.chromium.executablePath();
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // Fall through to default chrome-launcher lookup.
  }
  return null;
}

async function runLighthouseCapture({ playwright, options, layout, targets }) {
  const result = {
    enabled: options.collectLighthouse === true,
    status: 'disabled',
    totalRoutes: targets.length,
    okRoutes: 0,
    failedRoutes: 0,
    lighthouseMinScore: options.lighthouseMinScore,
    averagePerformanceScore: null,
    belowThresholdCount: 0,
    belowThresholdRoutes: [],
    reports: [],
    error: null,
  };
  if (!result.enabled) return result;
  if (!Array.isArray(targets) || targets.length < 1) {
    result.status = 'no_targets';
    return result;
  }

  ensureDir(layout.lighthouseDir);
  let chrome = null;
  try {
    const lighthouse = await readLighthouse();
    const chromeLauncher = readChromeLauncher();
    const chromePath = resolveChromiumExecutablePath(playwright);
    const launchOptions = {
      logLevel: 'error',
      chromeFlags: [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    };
    if (chromePath) {
      launchOptions.chromePath = chromePath;
    }
    chrome = await chromeLauncher.launch(launchOptions);
    for (const target of targets) {
      const routeToken = sanitizeToken(asString(target.route, '/').replace(/\//g, '_'), 'root');
      const reportPath = path.join(layout.lighthouseDir, `${routeToken}-${shortHash(target.url)}.lhr.json`);
      const entry = {
        route: target.route,
        url: target.url,
        source: target.source,
        ok: false,
        reportPath,
        metrics: null,
        error: null,
      };
      try {
        const runFlags = {
          port: chrome.port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: ['performance'],
          disableStorageReset: true,
          maxWaitForLoad: options.lighthouseTimeoutMs,
          throttlingMethod: 'provided',
          emulatedFormFactor: 'desktop',
          screenEmulation: { disabled: true },
        };
        const lhResult = await lighthouse(target.url, runFlags);
        const lhr = lhResult?.lhr || null;
        const reportRaw = Array.isArray(lhResult?.report)
          ? lhResult.report[0]
          : lhResult?.report;
        const reportJson = (typeof reportRaw === 'string' && reportRaw.trim().length > 0)
          ? reportRaw
          : JSON.stringify(lhr || {}, null, 2);
        fs.writeFileSync(reportPath, `${reportJson.trim()}\n`, 'utf8');
        entry.metrics = extractLighthouseMetrics(lhr || {});
        entry.ok = true;
      } catch (err) {
        entry.error = err.message || 'lighthouse_run_failed';
      }
      result.reports.push(entry);
    }
  } catch (err) {
    result.error = err.message || 'lighthouse_runtime_failed';
  } finally {
    if (chrome && typeof chrome.kill === 'function') {
      await chrome.kill().catch(() => {});
    }
  }

  const successful = result.reports.filter((entry) => entry.ok);
  result.okRoutes = successful.length;
  result.failedRoutes = Math.max(0, result.reports.length - successful.length);
  if (successful.length > 0) {
    const scoreSum = successful.reduce((sum, entry) => {
      const score = Number(entry?.metrics?.performanceScore);
      return Number.isFinite(score) ? sum + score : sum;
    }, 0);
    const scoreCount = successful.filter((entry) => Number.isFinite(Number(entry?.metrics?.performanceScore))).length;
    result.averagePerformanceScore = scoreCount > 0 ? roundMetric(scoreSum / scoreCount, 2) : null;
  }

  if (options.lighthouseMinScore >= 0) {
    result.belowThresholdRoutes = successful
      .filter((entry) => Number(entry?.metrics?.performanceScore) < options.lighthouseMinScore)
      .map((entry) => ({
        route: entry.route,
        url: entry.url,
        performanceScore: Number(entry?.metrics?.performanceScore),
        reportPath: entry.reportPath,
      }));
    result.belowThresholdCount = result.belowThresholdRoutes.length;
  }

  if (result.error) {
    result.status = 'error';
  } else if (result.okRoutes === result.totalRoutes) {
    result.status = 'ok';
  } else if (result.okRoutes > 0) {
    result.status = 'partial';
  } else {
    result.status = 'error';
    if (!result.error) result.error = 'lighthouse_all_routes_failed';
  }
  return result;
}

async function runFirefoxGateCheck({ playwright, options, targetUrl }) {
  const result = {
    required: options.runFirefoxGate === true,
    attempted: false,
    status: 'skipped',
    browser: 'firefox',
    profile: options.gateProfile,
    forced: options.forceFirefoxGate === true,
    url: targetUrl,
    finalUrl: null,
    title: null,
    elapsedMs: 0,
    selectorChecks: [],
    textChecks: [],
    consoleErrorCount: 0,
    pageErrorCount: 0,
    requestFailureCount: 0,
    httpErrorCount: 0,
    reasons: [],
    error: null,
    ok: true,
  };
  if (!result.required) return result;
  if (!targetUrl) {
    result.attempted = true;
    result.status = 'failed';
    result.ok = false;
    result.reasons.push('target_url_missing');
    return result;
  }

  const startedAtMs = Date.now();
  let browser = null;
  let context = null;
  let page = null;
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const httpErrors = [];
  try {
    result.attempted = true;
    const headless = options.headed ? false : true;
    browser = await playwright.firefox.launch({ headless });
    context = await browser.newContext({ viewport: options.viewport });
    page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(normalizeConsoleMessage(msg));
    });
    page.on('pageerror', (err) => {
      pageErrors.push(normalizePageError(err));
    });
    page.on('requestfailed', (req) => {
      requestFailures.push(normalizeRequestFailed(req));
    });
    page.on('response', (res) => {
      if (res.status() >= 400) httpErrors.push(normalizeHttpError(res));
    });

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
      };
      try {
        await page.waitForSelector(selector, {
          state: 'attached',
          timeout: options.selectorTimeoutMs,
        });
        check.ok = true;
      } catch (err) {
        check.error = err.message || 'selector_not_found';
        result.reasons.push(`required_selector_missing:${selector}`);
      }
      result.selectorChecks.push(check);
    }

    if (Array.isArray(options.requireTexts) && options.requireTexts.length > 0) {
      const bodyText = await page.evaluate(() => (document.body?.innerText || '').trim()).catch(() => '');
      const checks = buildRequiredTextChecks(bodyText, options.requireTexts, options.contentCaseSensitive === true);
      result.textChecks.push(...checks);
      for (const check of checks) {
        if (!check.ok) {
          result.reasons.push(`required_text_missing:${check.text}`);
        }
      }
    }

    result.title = await page.title().catch(() => null);
    result.finalUrl = page.url();
  } catch (err) {
    result.error = err.message || 'firefox_gate_runtime_failed';
    result.reasons.push(`navigation_failed:${result.error}`);
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  result.elapsedMs = Math.max(0, Date.now() - startedAtMs);
  result.consoleErrorCount = consoleErrors.length;
  result.pageErrorCount = pageErrors.length;
  result.requestFailureCount = requestFailures.length;
  result.httpErrorCount = httpErrors.length;
  if (consoleErrors.length > 0) result.reasons.push(`console_errors:${consoleErrors.length}`);
  if (pageErrors.length > 0) result.reasons.push(`page_errors:${pageErrors.length}`);
  if (requestFailures.length > 0) result.reasons.push(`request_failures:${requestFailures.length}`);
  if (httpErrors.length > 0) result.reasons.push(`http_errors:${httpErrors.length}`);

  result.ok = result.reasons.length === 0;
  result.status = result.ok ? 'pass' : 'failed';
  if (!result.ok && !result.error) {
    result.error = 'firefox_gate_failed';
  }
  return result;
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

function buildDiffBaselineKey(options = {}, targetUrl = '') {
  const projectToken = sanitizeToken(path.basename(asString(options.projectPath, 'project')), 'project');
  const routeToken = sanitizeToken(asString(options.route, '/').replace(/\//g, '_'), 'root');
  const url = asString(targetUrl, '');
  const keyRaw = `${asString(options.projectPath, '')}|${asString(options.route, '/')}|${url}`;
  return `${projectToken}-${routeToken}-${shortHash(keyRaw)}`;
}

function loadPng(filePath) {
  const raw = fs.readFileSync(filePath);
  return PNG.sync.read(raw);
}

function writePng(filePath, png) {
  const raw = PNG.sync.write(png);
  fs.writeFileSync(filePath, raw);
  return raw.length;
}

function copyFileIfPresent(sourcePath, destinationPath) {
  if (!sourcePath || !destinationPath) return null;
  if (!fs.existsSync(sourcePath)) return null;
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
  return destinationPath;
}

function buildNetworkSummary(requestFailures = [], httpErrors = []) {
  const requests = Array.isArray(requestFailures) ? requestFailures : [];
  const responses = Array.isArray(httpErrors) ? httpErrors : [];
  const hostMap = new Map();

  const touchHost = (url, mutate) => {
    let host = 'unknown';
    try {
      host = new URL(String(url || '')).host || host;
    } catch {
      // Keep default host bucket.
    }
    const prev = hostMap.get(host) || {
      host,
      requestFailures: 0,
      httpErrors: 0,
      statuses: {},
    };
    mutate(prev);
    hostMap.set(host, prev);
  };

  for (const item of requests) {
    touchHost(item?.url, (bucket) => {
      bucket.requestFailures += 1;
    });
  }
  for (const item of responses) {
    touchHost(item?.url, (bucket) => {
      bucket.httpErrors += 1;
      const statusCode = String(item?.status || 'unknown');
      bucket.statuses[statusCode] = (bucket.statuses[statusCode] || 0) + 1;
    });
  }

  return {
    requestFailureCount: requests.length,
    httpErrorCount: responses.length,
    hosts: Array.from(hostMap.values()).sort((a, b) => (
      (b.requestFailures + b.httpErrors) - (a.requestFailures + a.httpErrors)
    )),
    topRequestFailures: requests.slice(0, 20),
    topHttpErrors: responses.slice(0, 20),
  };
}

const FAILURE_GUIDANCE = Object.freeze({
  url_resolution_failed: 'Dev server URL could not be resolved/reached. Verify local server startup and port.',
  navigation_failed: 'Playwright navigation failed. Check routing, startup timing, and runtime JS errors.',
  required_selector_missing: 'Expected selector was missing. UI structure or render timing may have regressed.',
  required_text_missing: 'Expected user-visible content was missing from the rendered page.',
  broken_links_detected: 'One or more checked links returned HTTP errors or failed requests.',
  axe_violations_detected: 'Accessibility violations exceeded the configured threshold.',
  visual_diff_exceeded: 'Visual delta exceeded allowed diff pixels. Review before/after artifacts and diff image.',
  visual_diff_failed: 'Visual diff generation failed; verify screenshot dimensions and PNG decode integrity.',
  console_errors_detected: 'Browser console reported error-level events.',
  page_errors_detected: 'Unhandled page exceptions were captured.',
  http_errors_detected: 'HTTP responses >= 400 were observed during smoke run.',
  request_failures_detected: 'Network requests failed during smoke run.',
  insufficient_body_content: 'Rendered body text was below the configured minimum content threshold.',
  trace_capture_failed: 'Trace generation failed; debug context may be incomplete.',
  web_vitals_capture_failed: 'Web-vitals capture failed for one or more routes.',
  lighthouse_run_failed: 'Lighthouse audit did not complete successfully.',
  lighthouse_score_below_threshold: 'Lighthouse performance score fell below configured threshold.',
  firefox_gate_failed: 'Firefox browser gate failed for the smoke flow.',
});

function buildFailureExplanation(summary = {}, diagnostics = {}) {
  const failures = Array.isArray(summary.hardFailures) ? summary.hardFailures : [];
  const lines = [
    '# Smoke Failure Debug Summary',
    '',
    `- Run ID: ${summary.runId || 'unknown'}`,
    `- URL: ${summary.url || diagnostics.url || 'unresolved'}`,
    `- Hard failures: ${failures.length}`,
    '',
    '## Failure Signals',
  ];

  if (failures.length === 0) {
    lines.push('- No hard failures were recorded.');
  } else {
    for (const entry of failures) {
      const code = asString(entry?.code, 'hard_failure');
      const message = asString(entry?.message, 'Smoke failure');
      const guidance = FAILURE_GUIDANCE[code] || 'Inspect trace, console logs, and network diagnostics for root cause.';
      lines.push(`- ${code}: ${message}`);
      lines.push(`  guidance: ${guidance}`);
    }
  }

  lines.push('');
  lines.push('## Key Artifacts');
  lines.push(`- trace: ${summary.tracePath || 'n/a'}`);
  lines.push(`- screenshot(after): ${summary.afterImagePath || summary.screenshotPath || 'n/a'}`);
  lines.push(`- screenshot(before): ${summary.beforeImagePath || 'n/a'}`);
  lines.push(`- diff: ${summary.diffImagePath || 'n/a'}`);
  lines.push(`- diagnostics: ${summary.diagnosticsPath || 'n/a'}`);
  lines.push(`- network summary: ${summary.debugNetworkSummaryPath || 'n/a'}`);
  lines.push('');
  lines.push('## Suggested Next Steps');
  lines.push('1. Open the trace and replay navigation around the failing step.');
  lines.push('2. Compare before/after screenshots and diff image for visual regressions.');
  lines.push('3. Check network summary for failed API calls and status clusters.');

  return `${lines.join('\n')}\n`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function deriveSpecSlug(summary = {}, options = {}) {
  const routeToken = sanitizeToken(asString(summary.route || options.route, '/').replace(/\//g, '_'), 'root');
  const titleToken = sanitizeToken(asString(summary.title, ''), '');
  const key = summary.baselineKey || `${routeToken}-${shortHash(`${summary.url || ''}|${summary.route || ''}`)}`;
  if (titleToken) {
    return `${key}-${titleToken}`;
  }
  return key;
}

function buildSpecGenerationPaths(options = {}, summary = {}) {
  const slug = deriveSpecSlug(summary, options);
  const defaultSpecDir = path.join(options.runtimeRoot, 'generated-tests', 'playwright');
  const specDir = asString(options.specDir, '')
    ? path.resolve(asString(options.specDir, ''))
    : defaultSpecDir;
  const explicitOut = asString(options.specOut, '');
  const nameOverride = sanitizeToken(asString(options.specName, ''), '');
  const fileName = nameOverride
    ? `${nameOverride}.spec.ts`
    : `${slug}.spec.ts`;
  const specPath = explicitOut
    ? path.resolve(explicitOut)
    : path.join(specDir, fileName);
  return {
    slug,
    specDir,
    specPath,
    specMetaPath: `${specPath}.meta.json`,
  };
}

function buildAssistivePlaywrightSpecDraft({ summary = {}, diagnostics = {}, options = {}, generatedAt = new Date().toISOString() } = {}) {
  const selectors = asArray(diagnostics?.selectorChecks)
    .filter((entry) => entry && entry.ok && asString(entry.selector, ''))
    .map((entry) => asString(entry.selector, ''))
    .slice(0, 12);
  const requiredTexts = asArray(diagnostics?.textChecks)
    .filter((entry) => entry && entry.ok && asString(entry.text, ''))
    .map((entry) => asString(entry.text, ''))
    .slice(0, 12);
  const title = asString(summary.title, '');
  const url = asString(summary.url, '');
  const route = asString(summary.route, '/');
  const tracePath = asString(summary.tracePath, '');
  const runId = asString(summary.runId, '');
  const a11yViolationCount = Number(summary.axeViolationCount || 0);
  const brokenLinkCount = Number(summary.brokenLinkCount || 0);
  const lines = [
    "import { test, expect } from '@playwright/test';",
    '',
    '/**',
    ' * AUTO-GENERATED DRAFT by SquidRun (P4).',
    ' *',
    ' * HUMAN REVIEW REQUIRED BEFORE MERGE:',
    ' * 1. Verify selectors/assertions are stable for this feature.',
    ' * 2. Add domain-specific assertions for business behavior.',
    ' * 3. Split into multiple tests if this route has complex flows.',
    ' */',
    `const GENERATED_META = Object.freeze(${JSON.stringify({
      source: 'hm-smoke-runner',
      generatedAt,
      runId,
      route,
      url,
      tracePath,
      a11yViolationCount,
      brokenLinkCount,
    }, null, 2)});`,
    '',
    `test.describe('${deriveSpecSlug(summary, options)} (assistive draft)', () => {`,
    "  test('loads route and key UI anchors', async ({ page }) => {",
  ];

  if (url) {
    lines.push(`    await page.goto(${JSON.stringify(url)});`);
    lines.push(`    await expect(page).toHaveURL(${JSON.stringify(url)});`);
  } else {
    lines.push("    // TODO: set the correct URL/route for this generated test.");
    lines.push("    await page.goto('http://127.0.0.1:3000/');");
  }

  if (title) {
    const titleRegex = new RegExp(escapeRegExp(title), 'i').toString();
    lines.push(`    await expect(page).toHaveTitle(${titleRegex});`);
  } else {
    lines.push('    // TODO: add expected title assertion if applicable.');
  }

  if (selectors.length > 0) {
    lines.push('');
    lines.push('    // Captured from successful smoke selector checks.');
    for (const selector of selectors) {
      lines.push(`    await expect(page.locator(${JSON.stringify(selector)})).toBeVisible();`);
    }
  } else {
    lines.push('');
    lines.push('    // TODO: add stable selector assertions.');
  }

  if (requiredTexts.length > 0) {
    lines.push('');
    lines.push('    // Captured from successful smoke required-text checks.');
    for (const text of requiredTexts) {
      lines.push(`    await expect(page.getByText(${JSON.stringify(text)}, { exact: false })).toBeVisible();`);
    }
  } else {
    lines.push('');
    lines.push('    // TODO: add user-visible content assertions.');
  }

  lines.push('');
  lines.push('    // Assistive hints from smoke diagnostics:');
  lines.push(`    // a11y violations recorded: ${a11yViolationCount}`);
  lines.push(`    // broken links recorded: ${brokenLinkCount}`);
  if (tracePath) {
    lines.push(`    // trace artifact: ${tracePath}`);
  }
  lines.push('  });');
  lines.push('});');
  lines.push('');

  return `${lines.join('\n')}`;
}

function generateAssistivePlaywrightSpec({ summary = {}, diagnostics = {}, options = {} } = {}) {
  const paths = buildSpecGenerationPaths(options, summary);
  ensureDir(path.dirname(paths.specPath));
  ensureDir(path.dirname(paths.specMetaPath));
  const generatedAt = new Date().toISOString();
  const content = buildAssistivePlaywrightSpecDraft({
    summary,
    diagnostics,
    options,
    generatedAt,
  });
  fs.writeFileSync(paths.specPath, content, 'utf8');

  const metadata = {
    ok: true,
    source: 'hm-smoke-runner',
    generatedAt,
    runId: summary.runId || null,
    slug: paths.slug,
    specPath: paths.specPath,
    specMetaPath: paths.specMetaPath,
    route: summary.route || null,
    url: summary.url || null,
    tracePath: summary.tracePath || null,
    selectorCount: asArray(diagnostics?.selectorChecks).filter((entry) => entry?.ok).length,
    textAssertionCount: asArray(diagnostics?.textChecks).filter((entry) => entry?.ok).length,
    humanReviewRequired: true,
    reviewChecklist: [
      'Confirm selectors/assertions are stable',
      'Add business-level assertions',
      'Split by flow if needed',
    ],
  };
  writeJson(paths.specMetaPath, metadata);
  return metadata;
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildArtifactLayout(options) {
  const artifactRoot = asString(options.artifactRoot, '')
    ? path.resolve(asString(options.artifactRoot, ''))
    : path.join(options.runtimeRoot, 'screenshots', 'smoke-runs');
  const baselineRoot = path.join(options.runtimeRoot, 'screenshots', 'smoke-baselines');
  const runId = ensureRunId(options.runId, options.label || 'smoke');
  const runDir = path.join(artifactRoot, runId);
  ensureDir(runDir);
  ensureDir(baselineRoot);
  const debugDir = path.join(runDir, 'debug-package');
  const lighthouseDir = path.join(runDir, 'lighthouse');
  return {
    artifactRoot,
    baselineRoot,
    runId,
    runDir,
    screenshotPath: path.join(runDir, 'screenshot.png'),
    beforePath: path.join(runDir, 'before.png'),
    afterPath: path.join(runDir, 'after.png'),
    diffPath: path.join(runDir, 'diff.png'),
    tracePath: path.join(runDir, 'trace.zip'),
    domPath: path.join(runDir, 'dom.html'),
    ariaPath: path.join(runDir, 'aria-snapshot.json'),
    axePath: path.join(runDir, 'axe-report.json'),
    domSummaryPath: path.join(runDir, 'dom-summary.json'),
    linkCheckPath: path.join(runDir, 'link-checks.json'),
    webVitalsPath: path.join(runDir, 'web-vitals.json'),
    lighthouseSummaryPath: path.join(runDir, 'lighthouse-summary.json'),
    lighthouseDir,
    browserMatrixPath: path.join(runDir, 'browser-matrix.json'),
    debugDir,
    debugManifestPath: path.join(debugDir, 'package.json'),
    debugExplanationPath: path.join(debugDir, 'explanation.md'),
    debugNetworkSummaryPath: path.join(debugDir, 'network-summary.json'),
    debugTracePath: path.join(debugDir, 'trace.zip'),
    debugBeforePath: path.join(debugDir, 'before.png'),
    debugAfterPath: path.join(debugDir, 'after.png'),
    debugDiffPath: path.join(debugDir, 'diff.png'),
    debugScreenshotPath: path.join(debugDir, 'screenshot.png'),
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
    `Diff pixels: ${summary.diffPixelCount || 0}`,
    `Lighthouse(avg): ${summary.lighthouseAveragePerformanceScore ?? 'n/a'}`,
    `Firefox gate: ${summary.firefoxGateStatus || 'n/a'}`,
    `Hard failures: ${summary.hardFailureCount}`,
    `Run: ${summary.runId}`,
  ].join('\n');
}

function resolveBaselinePaths(options, layout, targetUrl) {
  const configured = sanitizeToken(options.baselineKey || '', '');
  const key = configured || buildDiffBaselineKey(options, targetUrl);
  return {
    baselineKey: key,
    baselinePath: path.join(layout.baselineRoot, `${key}.png`),
    baselineMetaPath: path.join(layout.baselineRoot, `${key}.json`),
  };
}

async function runVisualDiffPipeline({ options, layout, targetUrl, currentScreenshotPath }) {
  const enabled = options.enableVisualDiff === true;
  const baselinePaths = resolveBaselinePaths(options, layout, targetUrl);
  const result = {
    enabled,
    baselineKey: baselinePaths.baselineKey,
    baselinePath: baselinePaths.baselinePath,
    baselineMetaPath: baselinePaths.baselineMetaPath,
    baselineFound: false,
    beforeImagePath: null,
    afterImagePath: null,
    diffImagePath: null,
    diffGenerated: false,
    diffPixelCount: 0,
    diffRatio: null,
    diffThreshold: options.diffThreshold,
    diffThresholdExceeded: false,
    dimensionMismatch: false,
    baselineUpdated: false,
    baselineUpdateReason: 'not_attempted',
    error: null,
  };

  if (!enabled) {
    result.baselineUpdateReason = 'diff_disabled';
    return result;
  }
  if (!currentScreenshotPath || !fs.existsSync(currentScreenshotPath)) {
    result.error = 'current_screenshot_missing';
    result.baselineUpdateReason = 'current_screenshot_missing';
    return result;
  }

  result.afterImagePath = copyFileIfPresent(currentScreenshotPath, layout.afterPath);
  if (fs.existsSync(baselinePaths.baselinePath)) {
    result.baselineFound = true;
    result.beforeImagePath = copyFileIfPresent(baselinePaths.baselinePath, layout.beforePath);
    try {
      const pixelmatch = await readPixelmatch();
      const baselinePng = loadPng(baselinePaths.baselinePath);
      const currentPng = loadPng(currentScreenshotPath);
      if (baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height) {
        result.dimensionMismatch = true;
        result.error = `image_dimension_mismatch baseline=${baselinePng.width}x${baselinePng.height} current=${currentPng.width}x${currentPng.height}`;
      } else {
        const diffPng = new PNG({ width: currentPng.width, height: currentPng.height });
        const diffPixels = pixelmatch(
          baselinePng.data,
          currentPng.data,
          diffPng.data,
          currentPng.width,
          currentPng.height,
          { threshold: options.diffThreshold }
        );
        writePng(layout.diffPath, diffPng);
        result.diffGenerated = true;
        result.diffPixelCount = diffPixels;
        result.diffRatio = currentPng.width * currentPng.height > 0
          ? Number((diffPixels / (currentPng.width * currentPng.height)).toFixed(6))
          : 0;
        result.diffImagePath = layout.diffPath;
        if (options.maxDiffPixels >= 0 && diffPixels > options.maxDiffPixels) {
          result.diffThresholdExceeded = true;
        }
      }
    } catch (err) {
      result.error = err.message;
    }
  }

  result.baselineUpdateReason = 'pending';
  return result;
}

function maybeUpdateBaseline({ options, visualDiff, currentScreenshotPath, runId, targetUrl, finalHardFailureCount }) {
  if (!visualDiff || visualDiff.enabled !== true) return visualDiff;
  if (!currentScreenshotPath || !fs.existsSync(currentScreenshotPath)) {
    visualDiff.baselineUpdated = false;
    visualDiff.baselineUpdateReason = 'current_screenshot_missing';
    return visualDiff;
  }

  const shouldUpdateBaseline = options.updateBaselineAlways
    || (options.updateBaselineOnPass && finalHardFailureCount === 0);
  if (!shouldUpdateBaseline) {
    visualDiff.baselineUpdated = false;
    visualDiff.baselineUpdateReason = finalHardFailureCount > 0 ? 'run_failed' : 'disabled';
    return visualDiff;
  }

  try {
    copyFileIfPresent(currentScreenshotPath, visualDiff.baselinePath);
    writeJson(visualDiff.baselineMetaPath, {
      baselineKey: visualDiff.baselineKey,
      projectPath: options.projectPath,
      route: options.route,
      updatedAt: new Date().toISOString(),
      runId: runId || options.runId || null,
      url: targetUrl || null,
      diffPixelCount: visualDiff.diffPixelCount,
      diffRatio: visualDiff.diffRatio,
    });
    visualDiff.baselineUpdated = true;
    visualDiff.baselineUpdateReason = options.updateBaselineAlways ? 'always' : 'on_pass';
  } catch (err) {
    visualDiff.baselineUpdated = false;
    visualDiff.baselineUpdateReason = 'baseline_write_failed';
    if (!visualDiff.error) visualDiff.error = err.message;
  }

  return visualDiff;
}

function buildFailureDebugPackage({ layout, summary, diagnostics }) {
  if (!layout || !summary || summary.hardFailureCount < 1) return null;

  ensureDir(layout.debugDir);
  const networkSummary = buildNetworkSummary(
    diagnostics?.signals?.requestFailures || [],
    diagnostics?.signals?.httpErrors || []
  );
  writeJson(layout.debugNetworkSummaryPath, networkSummary);

  const beforePath = copyFileIfPresent(summary.beforeImagePath, layout.debugBeforePath);
  const afterPath = copyFileIfPresent(summary.afterImagePath || summary.screenshotPath, layout.debugAfterPath)
    || copyFileIfPresent(summary.screenshotPath, layout.debugScreenshotPath);
  const diffPath = copyFileIfPresent(summary.diffImagePath, layout.debugDiffPath);
  const tracePath = copyFileIfPresent(summary.tracePath, layout.debugTracePath);
  const screenshotPath = copyFileIfPresent(summary.screenshotPath, layout.debugScreenshotPath);

  const packageSummary = {
    runId: summary.runId || null,
    generatedAt: new Date().toISOString(),
    url: summary.url || null,
    status: summary.ok ? 'PASS' : 'FAIL',
    hardFailureCount: summary.hardFailureCount || 0,
    hardFailures: Array.isArray(summary.hardFailures) ? summary.hardFailures : [],
    visualDiff: {
      diffPixelCount: summary.diffPixelCount || 0,
      diffRatio: summary.diffRatio || null,
      diffThresholdExceeded: summary.diffThresholdExceeded === true,
      baselineKey: summary.baselineKey || null,
    },
    files: {
      trace: tracePath,
      screenshot: screenshotPath,
      before: beforePath,
      after: afterPath,
      diff: diffPath,
      networkSummary: layout.debugNetworkSummaryPath,
      explanation: layout.debugExplanationPath,
      diagnostics: summary.diagnosticsPath || null,
    },
  };

  summary.debugNetworkSummaryPath = layout.debugNetworkSummaryPath;
  const explanation = buildFailureExplanation(summary, diagnostics);
  fs.writeFileSync(layout.debugExplanationPath, explanation, 'utf8');
  writeJson(layout.debugManifestPath, packageSummary);

  return {
    dir: layout.debugDir,
    manifestPath: layout.debugManifestPath,
    explanationPath: layout.debugExplanationPath,
    networkSummaryPath: layout.debugNetworkSummaryPath,
    tracePath,
    beforePath,
    afterPath,
    diffPath,
    screenshotPath,
  };
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
  const perfRouteValues = getOptionList(options, 'perf-route');
  const perfRoutes = perfRouteValues
    .map((value) => {
      if (value === true) {
        throw new Error('--perf-route expects a route value');
      }
      return normalizeRouteToken(value);
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
  const maxDiffPixelsRaw = getOption(options, 'max-diff-pixels', DEFAULT_MAX_DIFF_PIXELS);
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
  const enableVisualDiff = resolveBooleanFlag(options, {
    enableKey: 'diff',
    disableKey: 'no-diff',
    defaultValue: true,
  });
  const updateBaselineOnPass = !options.has('no-update-baseline');
  const updateBaselineAlways = options.has('update-baseline-always');
  const generateSpec = resolveBooleanFlag(options, {
    enableKey: 'generate-spec',
    disableKey: 'no-generate-spec',
    defaultValue: true,
  });
  const perfEnabled = resolveBooleanFlag(options, {
    enableKey: 'perf',
    disableKey: 'no-perf',
    defaultValue: true,
  });
  const collectWebVitals = perfEnabled && resolveBooleanFlag(options, {
    enableKey: 'web-vitals',
    disableKey: 'no-web-vitals',
    defaultValue: true,
  });
  const collectLighthouse = perfEnabled && resolveBooleanFlag(options, {
    enableKey: 'lighthouse',
    disableKey: 'no-lighthouse',
    defaultValue: true,
  });
  const enableBrowserMatrix = !options.has('no-browser-matrix');
  const gateProfile = normalizeGateProfile(
    getOption(options, 'gate-profile', process.env.SQUIDRUN_SMOKE_GATE_PROFILE || DEFAULT_GATE_PROFILE),
    DEFAULT_GATE_PROFILE
  );
  const forceFirefoxGate = options.has('force-firefox-gate')
    || /^(1|true|yes)$/i.test(asString(process.env.SQUIDRUN_FORCE_FIREFOX_GATE, ''));
  const runFirefoxGate = shouldRunFirefoxGate({
    enableBrowserMatrix,
    gateProfile,
    forceFirefoxGate,
  });
  const lighthouseMinScore = options.has('lighthouse-min-score')
    ? asNullableFloatInRange(getOption(options, 'lighthouse-min-score', ''), null, 0, 100)
    : DEFAULT_LIGHTHOUSE_MIN_SCORE;
  const normalizedLighthouseMinScore = lighthouseMinScore === null
    ? DEFAULT_LIGHTHOUSE_MIN_SCORE
    : lighthouseMinScore;

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
    maxDiffPixels: options.has('max-diff-pixels')
      ? asNonNegativeInt(maxDiffPixelsRaw, 0)
      : DEFAULT_MAX_DIFF_PIXELS,
    diffThreshold: asFloatInRange(getOption(options, 'diff-threshold', DEFAULT_PIXEL_DIFF_THRESHOLD), DEFAULT_PIXEL_DIFF_THRESHOLD, 0, 1),
    baselineKey: asString(getOption(options, 'baseline-key', ''), ''),
    enableVisualDiff,
    updateBaselineOnPass,
    updateBaselineAlways,
    generateSpec,
    specDir: asString(getOption(options, 'spec-dir', ''), ''),
    specOut: asString(getOption(options, 'spec-out', ''), ''),
    specName: asString(getOption(options, 'spec-name', ''), ''),
    perfEnabled,
    collectWebVitals,
    collectLighthouse,
    perfRoutes,
    lighthouseMinScore: normalizedLighthouseMinScore,
    lighthouseTimeoutMs: asPositiveInt(getOption(options, 'lighthouse-timeout-ms', DEFAULT_LIGHTHOUSE_TIMEOUT_MS), DEFAULT_LIGHTHOUSE_TIMEOUT_MS),
    gateProfile,
    forceFirefoxGate,
    enableBrowserMatrix,
    runFirefoxGate,
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
  let visualDiff = null;
  let debugPackage = null;
  let specGeneration = null;
  let webVitalsReport = null;
  let lighthouseReport = null;
  let browserMatrix = null;
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
    visualDiffError: null,
    specGenerationError: null,
    webVitalsError: null,
    lighthouseError: null,
    firefoxGateError: null,
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
        browserMatrix = {
          enabled: options.enableBrowserMatrix !== false,
          gateProfile: options.gateProfile,
          firefoxGateRequired: options.runFirefoxGate === true,
          primary: {
            browser: 'chromium',
            status: 'pass',
            url: runtime.finalUrl || targetUrl,
            title: runtime.title,
            selectorCount: options.requireSelectors.length,
            missingSelectorCount: selectorChecks.filter((entry) => !entry.ok).length,
            requiredTextCount: options.requireTexts.length,
            missingTextCount: textChecks.filter((entry) => !entry.ok).length,
            consoleErrorCount: consoleErrors.length,
            pageErrorCount: pageErrors.length,
            requestFailureCount: requestFailures.length,
            httpErrorCount: httpErrors.length,
          },
          firefox: {
            required: options.runFirefoxGate === true,
            attempted: false,
            status: options.runFirefoxGate ? 'pending' : 'skipped',
            ok: options.runFirefoxGate ? false : true,
            reasons: [],
          },
        };
        visualDiff = await runVisualDiffPipeline({
          options,
          layout,
          targetUrl: runtime.finalUrl || targetUrl,
          currentScreenshotPath: layout.screenshotPath,
        });
        if (visualDiff?.error) {
          runtime.visualDiffError = visualDiff.error;
          if (visualDiff.baselineFound) {
            failures.add('visual_diff_failed', `Visual diff failed (${visualDiff.error})`, {
              baselineKey: visualDiff.baselineKey,
            });
          }
        }
        if (visualDiff?.diffThresholdExceeded) {
          failures.add(
            'visual_diff_exceeded',
            `Visual diff pixels ${visualDiff.diffPixelCount} exceed allowed ${options.maxDiffPixels}`,
            {
              diffPixelCount: visualDiff.diffPixelCount,
              maxDiffPixels: options.maxDiffPixels,
              diffRatio: visualDiff.diffRatio,
              baselineKey: visualDiff.baselineKey,
            }
          );
        }
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

  const activeTargetUrl = runtime.finalUrl || targetUrl;
  const perfTargets = activeTargetUrl
    ? buildPerformanceTargets(options, activeTargetUrl)
    : [];

  if (options.perfEnabled && activeTargetUrl) {
    let playwright = null;
    try {
      playwright = readPlaywright();
    } catch (err) {
      runtime.webVitalsError = err.message;
      runtime.lighthouseError = err.message;
    }

    if (playwright && options.collectWebVitals) {
      webVitalsReport = await runWebVitalsCapture({
        playwright,
        options,
        targets: perfTargets,
      });
      if (webVitalsReport.status === 'error') {
        runtime.webVitalsError = webVitalsReport.error || 'web_vitals_capture_failed';
        failures.add('web_vitals_capture_failed', runtime.webVitalsError, {
          totalRoutes: webVitalsReport.totalRoutes,
          failedRoutes: webVitalsReport.failedRoutes,
        });
      }
    } else if (!options.collectWebVitals) {
      webVitalsReport = {
        enabled: false,
        status: options.perfEnabled ? 'disabled' : 'perf_disabled',
      };
    }

    if (playwright && options.collectLighthouse) {
      lighthouseReport = await runLighthouseCapture({
        playwright,
        options,
        layout,
        targets: perfTargets,
      });
      if (lighthouseReport.status === 'error') {
        runtime.lighthouseError = lighthouseReport.error || 'lighthouse_run_failed';
        failures.add('lighthouse_run_failed', runtime.lighthouseError, {
          totalRoutes: lighthouseReport.totalRoutes,
          failedRoutes: lighthouseReport.failedRoutes,
        });
      } else if (options.lighthouseMinScore >= 0 && lighthouseReport.belowThresholdCount > 0) {
        failures.add(
          'lighthouse_score_below_threshold',
          `${lighthouseReport.belowThresholdCount} route(s) below Lighthouse threshold ${options.lighthouseMinScore}`,
          {
            lighthouseMinScore: options.lighthouseMinScore,
            belowThresholdRoutes: lighthouseReport.belowThresholdRoutes,
          }
        );
      }
    } else if (!options.collectLighthouse) {
      lighthouseReport = {
        enabled: false,
        status: options.perfEnabled ? 'disabled' : 'perf_disabled',
      };
    }
  } else {
    webVitalsReport = {
      enabled: false,
      status: options.perfEnabled ? 'no_target' : 'perf_disabled',
    };
    lighthouseReport = {
      enabled: false,
      status: options.perfEnabled ? 'no_target' : 'perf_disabled',
    };
  }

  if (!browserMatrix) {
    browserMatrix = {
      enabled: options.enableBrowserMatrix !== false,
      gateProfile: options.gateProfile,
      firefoxGateRequired: options.runFirefoxGate === true,
      primary: null,
      firefox: {
        required: options.runFirefoxGate === true,
        attempted: false,
        status: options.runFirefoxGate ? 'pending' : 'skipped',
        ok: options.runFirefoxGate ? false : true,
        reasons: [],
      },
    };
  }

  const primaryReasons = [];
  if (runtime.navigationError) primaryReasons.push('navigation_failed');
  if (selectorChecks.some((entry) => !entry.ok)) primaryReasons.push('required_selector_missing');
  if (textChecks.some((entry) => !entry.ok)) primaryReasons.push('required_text_missing');
  if (consoleErrors.length > 0) primaryReasons.push('console_errors_detected');
  if (pageErrors.length > 0) primaryReasons.push('page_errors_detected');
  if (requestFailures.length > 0) primaryReasons.push('request_failures_detected');
  if (httpErrors.length > 0) primaryReasons.push('http_errors_detected');
  browserMatrix.primary = {
    browser: 'chromium',
    status: primaryReasons.length === 0 ? 'pass' : 'failed',
    ok: primaryReasons.length === 0,
    reasons: primaryReasons,
    url: activeTargetUrl || null,
    title: runtime.title,
    selectorCount: options.requireSelectors.length,
    missingSelectorCount: selectorChecks.filter((entry) => !entry.ok).length,
    requiredTextCount: options.requireTexts.length,
    missingTextCount: textChecks.filter((entry) => !entry.ok).length,
    consoleErrorCount: consoleErrors.length,
    pageErrorCount: pageErrors.length,
    requestFailureCount: requestFailures.length,
    httpErrorCount: httpErrors.length,
  };

  if (options.runFirefoxGate && activeTargetUrl) {
    let playwright = null;
    try {
      playwright = readPlaywright();
      const firefoxGate = await runFirefoxGateCheck({
        playwright,
        options,
        targetUrl: activeTargetUrl,
      });
      browserMatrix.firefox = firefoxGate;
      if (!firefoxGate.ok) {
        runtime.firefoxGateError = firefoxGate.error || 'firefox_gate_failed';
        failures.add('firefox_gate_failed', 'Firefox gate failed', {
          reasons: firefoxGate.reasons,
          error: runtime.firefoxGateError,
        });
      }
    } catch (err) {
      runtime.firefoxGateError = err.message;
      browserMatrix.firefox = {
        required: true,
        attempted: true,
        status: 'failed',
        browser: 'firefox',
        profile: options.gateProfile,
        forced: options.forceFirefoxGate === true,
        url: activeTargetUrl,
        ok: false,
        reasons: ['firefox_runtime_failed'],
        error: err.message,
      };
      failures.add('firefox_gate_failed', `Firefox gate runtime failed (${err.message})`);
    }
  }

  if (visualDiff && visualDiff.enabled === true) {
    visualDiff = maybeUpdateBaseline({
      options,
      visualDiff,
      currentScreenshotPath: layout.screenshotPath,
      runId: layout.runId,
      targetUrl: runtime.finalUrl || targetUrl,
      finalHardFailureCount: failures.list.length,
    });
    if (visualDiff.error && !runtime.visualDiffError) {
      runtime.visualDiffError = visualDiff.error;
    }
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
  if (webVitalsReport !== null) {
    writeJson(layout.webVitalsPath, webVitalsReport);
  }
  if (lighthouseReport !== null) {
    writeJson(layout.lighthouseSummaryPath, lighthouseReport);
  }
  if (browserMatrix !== null) {
    writeJson(layout.browserMatrixPath, browserMatrix);
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
      visualDiff,
      webVitalsReport,
      lighthouseReport,
      browserMatrix,
      specGeneration,
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
    webVitalsPath: fileOrNull(layout.webVitalsPath),
    lighthouseSummaryPath: fileOrNull(layout.lighthouseSummaryPath),
    browserMatrixPath: fileOrNull(layout.browserMatrixPath),
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
    baselineKey: visualDiff?.baselineKey || null,
    baselinePath: visualDiff?.baselinePath || null,
    beforeImagePath: fileOrNull(visualDiff?.beforeImagePath || layout.beforePath),
    afterImagePath: fileOrNull(visualDiff?.afterImagePath || layout.afterPath),
    diffImagePath: fileOrNull(visualDiff?.diffImagePath || layout.diffPath),
    diffPixelCount: Number(visualDiff?.diffPixelCount || 0),
    diffRatio: typeof visualDiff?.diffRatio === 'number' ? visualDiff.diffRatio : null,
    diffThreshold: typeof visualDiff?.diffThreshold === 'number' ? visualDiff.diffThreshold : null,
    diffThresholdExceeded: visualDiff?.diffThresholdExceeded === true,
    baselineFound: visualDiff?.baselineFound === true,
    baselineUpdated: visualDiff?.baselineUpdated === true,
    baselineUpdateReason: visualDiff?.baselineUpdateReason || null,
    visualDiffError: visualDiff?.error || null,
    perfEnabled: options.perfEnabled === true,
    perfRouteCount: perfTargets.length,
    webVitalsStatus: webVitalsReport?.status || 'not_run',
    webVitalsOkRoutes: Number(webVitalsReport?.okRoutes || 0),
    webVitalsFailedRoutes: Number(webVitalsReport?.failedRoutes || 0),
    webVitalsError: webVitalsReport?.error || null,
    lighthouseStatus: lighthouseReport?.status || 'not_run',
    lighthouseAveragePerformanceScore: Number.isFinite(Number(lighthouseReport?.averagePerformanceScore))
      ? Number(lighthouseReport.averagePerformanceScore)
      : null,
    lighthouseMinScore: options.lighthouseMinScore,
    lighthouseBelowThresholdCount: Number(lighthouseReport?.belowThresholdCount || 0),
    lighthouseError: lighthouseReport?.error || null,
    gateProfile: options.gateProfile,
    firefoxGateRequired: options.runFirefoxGate === true,
    firefoxGateStatus: browserMatrix?.firefox?.status || 'not_run',
    firefoxGateOk: browserMatrix?.firefox?.ok === true,
    firefoxGateError: browserMatrix?.firefox?.error || null,
    debugPackagePath: null,
    debugManifestPath: null,
    debugExplanationPath: null,
    debugNetworkSummaryPath: null,
    generatedSpecPath: null,
    generatedSpecMetaPath: null,
    specGenerationStatus: null,
    specGenerationError: null,
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
  if (summary.hardFailureCount > 0) {
    debugPackage = buildFailureDebugPackage({
      layout,
      summary,
      diagnostics,
    });
    if (debugPackage) {
      summary.debugPackagePath = debugPackage.dir || null;
      summary.debugManifestPath = debugPackage.manifestPath || null;
      summary.debugExplanationPath = debugPackage.explanationPath || null;
      summary.debugNetworkSummaryPath = debugPackage.networkSummaryPath || null;
    }
  }
  if (summary.ok && options.generateSpec) {
    try {
      specGeneration = generateAssistivePlaywrightSpec({
        summary,
        diagnostics,
        options,
      });
      summary.generatedSpecPath = specGeneration.specPath || null;
      summary.generatedSpecMetaPath = specGeneration.specMetaPath || null;
      summary.specGenerationStatus = 'generated';
    } catch (err) {
      runtime.specGenerationError = err.message;
      summary.specGenerationStatus = 'generation_failed';
      summary.specGenerationError = err.message;
    }
  } else if (!summary.ok && options.generateSpec) {
    summary.specGenerationStatus = 'skipped_run_failed';
  } else if (!options.generateSpec) {
    summary.specGenerationStatus = 'disabled';
  }
  diagnostics.runtime = runtime;
  diagnostics.hardFailures = failures.list.slice();
  diagnostics.debugPackage = debugPackage;
  diagnostics.specGeneration = specGeneration;
  diagnostics.signals.specGeneration = specGeneration;

  writeJson(layout.diagnosticsPath, diagnostics);
  writeJson(layout.summaryPath, summary);
  writeJson(layout.manifestPath, {
    runId: layout.runId,
    generatedAt: finishedAt,
    runDir: layout.runDir,
    files: {
      screenshot: summary.screenshotPath,
      before: summary.beforeImagePath,
      after: summary.afterImagePath,
      diff: summary.diffImagePath,
      trace: summary.tracePath,
      dom: summary.domPath,
      aria: summary.ariaPath,
      axe: summary.axePath,
      domSummary: summary.domSummaryPath,
      linkChecks: summary.linkCheckPath,
      webVitals: summary.webVitalsPath,
      lighthouseSummary: summary.lighthouseSummaryPath,
      browserMatrix: summary.browserMatrixPath,
      debugPackage: summary.debugPackagePath,
      debugManifest: summary.debugManifestPath,
      debugExplanation: summary.debugExplanationPath,
      debugNetworkSummary: summary.debugNetworkSummaryPath,
      generatedSpec: summary.generatedSpecPath,
      generatedSpecMeta: summary.generatedSpecMetaPath,
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
      webVitalsOkRoutes: summary.webVitalsOkRoutes,
      webVitalsFailedRoutes: summary.webVitalsFailedRoutes,
      lighthouseBelowThreshold: summary.lighthouseBelowThresholdCount,
      firefoxGateFailed: summary.firefoxGateRequired && !summary.firefoxGateOk ? 1 : 0,
      diffPixels: summary.diffPixelCount,
      diffThresholdExceeded: summary.diffThresholdExceeded ? 1 : 0,
      generatedSpec: summary.generatedSpecPath ? 1 : 0,
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
  normalizeGateProfile,
  shouldRunFirefoxGate,
  collectRunOptions,
  buildArtifactLayout,
  buildDiffBaselineKey,
  buildPerformanceTargets,
  buildFailureExplanation,
  buildAssistivePlaywrightSpecDraft,
  buildSpecGenerationPaths,
  generateAssistivePlaywrightSpec,
  runVisualDiffPipeline,
  maybeUpdateBaseline,
  runSmoke,
  main,
};
