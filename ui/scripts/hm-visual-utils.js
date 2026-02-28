const fs = require('fs');
const path = require('path');
const {
  setProjectRoot,
  getProjectRoot,
  getSquidrunRoot,
  resolveCoordPath,
} = require('../config');

const DEFAULT_HEURISTIC_PORTS = [3000, 3001, 4173, 5173, 8080, 4200, 4321, 8000, 8888];
const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_READY_POLL_MS = 500;

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asPositiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function sleep(ms) {
  const timeoutMs = asPositiveInt(ms, 0);
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, payload) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  ensureDir(dir);
  const tempPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, resolved);
    return { ok: true, path: resolved };
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Best effort cleanup.
    }
    return { ok: false, error: err.message };
  }
}

function resolveProjectPath(options = {}) {
  const opts = asObject(options);
  const explicit = asString(opts.projectPath || opts.projectRoot, '');
  if (explicit) return path.resolve(explicit);
  const current = typeof getProjectRoot === 'function' ? asString(getProjectRoot(), '') : '';
  if (current) return path.resolve(current);
  return path.resolve(process.cwd());
}

function resolveVisualRuntimeRoot(options = {}) {
  const projectPath = resolveProjectPath(options);
  if (typeof setProjectRoot === 'function') {
    try {
      setProjectRoot(projectPath);
    } catch {
      // Best-effort sync only.
    }
  }
  if (typeof resolveCoordPath === 'function') {
    const coordRoot = resolveCoordPath('.', { forWrite: true });
    return path.resolve(coordRoot);
  }
  return path.join(projectPath, '.squidrun');
}

function normalizeUrlCandidate(input) {
  const raw = asString(input, '');
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    return parsed.toString();
  } catch {
    return null;
  }
}

function applyRouteToUrl(baseUrl, route = '/') {
  const normalizedBase = normalizeUrlCandidate(baseUrl);
  if (!normalizedBase) return null;
  const rawRoute = asString(route, '/');
  if (!rawRoute || rawRoute === '/') return normalizedBase;

  try {
    const target = new URL(normalizedBase);
    target.pathname = rawRoute.startsWith('/') ? rawRoute : `/${rawRoute}`;
    target.search = '';
    target.hash = '';
    return target.toString();
  } catch {
    return normalizedBase;
  }
}

function parsePortHintsFromText(text) {
  const raw = asString(text, '');
  if (!raw) return [];
  const ports = new Set();

  const patterns = [
    /(?:--port|-p)\s+(\d{2,5})/gi,
    /(?:^|\s)port\s*=\s*(\d{2,5})(?:\s|$)/gi,
    /(?:^|\s)PORT\s*=\s*(\d{2,5})(?:\s|$)/g,
    /localhost:(\d{2,5})/gi,
    /127\.0\.0\.1:(\d{2,5})/g,
  ];

  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(raw))) {
      const port = Number.parseInt(match[1], 10);
      if (Number.isFinite(port) && port > 0 && port <= 65535) {
        ports.add(port);
      }
    }
  }

  return [...ports];
}

function detectFrameworkHints(projectPath, pkg = null) {
  const frameworks = [];
  const scripts = asObject(pkg?.scripts);
  const deps = {
    ...asObject(pkg?.dependencies),
    ...asObject(pkg?.devDependencies),
  };

  const scriptJoined = Object.values(scripts).map((v) => asString(v, '')).join(' ').toLowerCase();
  const hasFile = (name) => fs.existsSync(path.join(projectPath, name));

  if (deps.next || hasFile('next.config.js') || hasFile('next.config.mjs') || scriptJoined.includes('next dev')) {
    frameworks.push('next');
  }
  if (deps.vite || hasFile('vite.config.js') || hasFile('vite.config.ts') || scriptJoined.includes('vite')) {
    frameworks.push('vite');
  }
  if (deps.astro || hasFile('astro.config.mjs') || scriptJoined.includes('astro')) {
    frameworks.push('astro');
  }
  if (deps['@angular/core'] || scriptJoined.includes('ng serve')) {
    frameworks.push('angular');
  }
  if (deps['react-scripts'] || scriptJoined.includes('react-scripts start')) {
    frameworks.push('react-scripts');
  }

  return [...new Set(frameworks)];
}

function frameworkDefaultPorts(frameworks = []) {
  const ports = [];
  const add = (value) => {
    if (!ports.includes(value)) ports.push(value);
  };

  for (const fw of frameworks) {
    if (fw === 'next') add(3000);
    if (fw === 'vite') add(5173);
    if (fw === 'astro') add(4321);
    if (fw === 'angular') add(4200);
    if (fw === 'react-scripts') add(3000);
  }

  for (const port of DEFAULT_HEURISTIC_PORTS) add(port);
  return ports;
}

function buildHeuristicUrlCandidates(options = {}) {
  const opts = asObject(options);
  const projectPath = resolveProjectPath(opts);
  const packageJsonPath = path.join(projectPath, 'package.json');
  const pkg = readJsonFileSafe(packageJsonPath);
  const scripts = asObject(pkg?.scripts);
  const frameworks = detectFrameworkHints(projectPath, pkg);
  const ports = new Set(frameworkDefaultPorts(frameworks));

  for (const scriptText of Object.values(scripts)) {
    for (const port of parsePortHintsFromText(scriptText)) {
      ports.add(port);
    }
  }

  const envPort = asPositiveInt(process.env.PORT, null);
  if (envPort) ports.add(envPort);

  const route = asString(opts.route, '/');
  const candidates = [];
  for (const port of ports) {
    const bases = [
      `http://127.0.0.1:${port}/`,
      `http://localhost:${port}/`,
    ];
    for (const base of bases) {
      const candidate = applyRouteToUrl(base, route);
      if (candidate && !candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  return {
    projectPath,
    packageJsonPath,
    frameworks,
    scripts,
    candidates,
  };
}

function getVisualUrlCachePath(options = {}) {
  const opts = asObject(options);
  const explicit = asString(opts.cachePath, '');
  if (explicit) return path.resolve(explicit);
  const runtimeRoot = resolveVisualRuntimeRoot(opts);
  return path.join(runtimeRoot, 'state', 'visual-url-cache.json');
}

function readVisualUrlCache(options = {}) {
  const cachePath = getVisualUrlCachePath(options);
  const cache = readJsonFileSafe(cachePath) || { version: 1, projects: {} };
  if (!cache.projects || typeof cache.projects !== 'object') {
    cache.projects = {};
  }
  return { cachePath, cache };
}

function writeVisualUrlCache(cachePayload, options = {}) {
  const cachePath = getVisualUrlCachePath(options);
  return writeJsonAtomic(cachePath, cachePayload);
}

function cacheKeyForProject(projectPath) {
  return path.resolve(projectPath).toLowerCase();
}

function readCachedVisualUrl(projectPath, options = {}) {
  const { cachePath, cache } = readVisualUrlCache(options);
  const key = cacheKeyForProject(projectPath);
  const entry = asObject(cache.projects[key]);
  const url = normalizeUrlCandidate(entry.url || '');
  return { cachePath, key, entry, url, projectPath };
}

function writeCachedVisualUrl(projectPath, url, meta = {}, options = {}) {
  const normalizedUrl = normalizeUrlCandidate(url);
  if (!normalizedUrl) {
    return { ok: false, error: 'invalid_url' };
  }
  const { cachePath, cache } = readVisualUrlCache(options);
  const key = cacheKeyForProject(projectPath);
  const entry = {
    url: normalizedUrl,
    updatedAt: new Date().toISOString(),
    projectPath: path.resolve(projectPath),
    ...asObject(meta),
  };
  cache.version = 1;
  cache.projects[key] = entry;
  const result = writeJsonAtomic(cachePath, cache);
  return {
    ...result,
    cachePath,
    key,
    projectPath: path.resolve(projectPath),
    entry,
  };
}

function resolveVisualUrlCandidates(options = {}) {
  const opts = asObject(options);
  const projectPath = resolveProjectPath(opts);
  const route = asString(opts.route, '/');
  const explicitUrl = normalizeUrlCandidate(opts.url || opts.explicitUrl || '');
  const cached = readCachedVisualUrl(projectPath, opts);
  const cachedUrl = cached.url ? applyRouteToUrl(cached.url, route) : null;
  const heuristics = buildHeuristicUrlCandidates({ ...opts, projectPath, route });
  const candidates = [];

  if (explicitUrl) {
    const withRoute = applyRouteToUrl(explicitUrl, route);
    if (withRoute) candidates.push({ source: 'explicit', url: withRoute });
  }
  if (cachedUrl) {
    candidates.push({ source: 'cache', url: cachedUrl });
  }
  for (const item of heuristics.candidates) {
    candidates.push({ source: 'heuristic', url: item });
  }

  const deduped = [];
  const seen = new Set();
  for (const entry of candidates) {
    const key = `${entry.url}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return {
    ok: deduped.length > 0,
    reason: deduped.length > 0 ? null : 'no_candidates',
    projectPath,
    explicitUrl,
    cachedUrl,
    candidates: deduped,
    heuristics,
  };
}

function resolveVisualUrl(options = {}) {
  const resolved = resolveVisualUrlCandidates(options);
  if (!resolved.ok || resolved.candidates.length === 0) {
    return {
      ...resolved,
      ok: false,
      reason: resolved.reason || 'no_candidates',
    };
  }
  const first = resolved.candidates[0];
  return {
    ...resolved,
    ok: true,
    url: first.url,
    source: first.source,
  };
}

async function probeHttpReadiness(targetUrl, options = {}) {
  const opts = asObject(options);
  const timeoutMs = asPositiveInt(opts.timeoutMs, 3000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    return {
      ok: response.status >= 200 && response.status < 500,
      url: targetUrl,
      statusCode: response.status,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      url: targetUrl,
      statusCode: null,
      error: err?.message || 'request_failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttpReady(targetUrl, options = {}) {
  const opts = asObject(options);
  const timeoutMs = asPositiveInt(opts.timeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const pollMs = asPositiveInt(opts.pollMs, DEFAULT_READY_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastResult = null;

  while (Date.now() <= deadline) {
    attempts += 1;
    lastResult = await probeHttpReadiness(targetUrl, opts);
    if (lastResult.ok) {
      return {
        ok: true,
        url: targetUrl,
        attempts,
        statusCode: lastResult.statusCode,
        elapsedMs: timeoutMs - Math.max(0, deadline - Date.now()),
        lastError: null,
      };
    }
    await sleep(pollMs);
  }

  return {
    ok: false,
    url: targetUrl,
    attempts,
    statusCode: lastResult?.statusCode || null,
    elapsedMs: timeoutMs,
    lastError: lastResult?.error || 'timeout',
  };
}

async function resolveReadyVisualUrl(options = {}) {
  const opts = asObject(options);
  const resolution = resolveVisualUrlCandidates(opts);
  if (!resolution.ok || resolution.candidates.length === 0) {
    return {
      ok: false,
      reason: resolution.reason || 'no_candidates',
      checks: [],
      resolution,
    };
  }

  const checks = [];
  const maxCandidates = asPositiveInt(opts.maxCandidates, resolution.candidates.length);
  const candidates = resolution.candidates.slice(0, maxCandidates);
  const perCandidateTimeoutMs = asPositiveInt(
    opts.candidateTimeoutMs,
    Math.min(8000, asPositiveInt(opts.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS))
  );

  for (const candidate of candidates) {
    const ready = await waitForHttpReady(candidate.url, {
      timeoutMs: perCandidateTimeoutMs,
      pollMs: asPositiveInt(opts.pollMs, DEFAULT_READY_POLL_MS),
    });
    checks.push({
      source: candidate.source,
      candidate: candidate.url,
      ...ready,
    });
    if (ready.ok) {
      return {
        ok: true,
        url: candidate.url,
        source: candidate.source,
        candidate,
        checks,
        resolution,
      };
    }
  }

  return {
    ok: false,
    reason: 'no_ready_candidate',
    checks,
    resolution,
  };
}

function buildVisualRunId(label = 'capture', nowMs = Date.now()) {
  const safeLabel = asString(label, 'capture')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'capture';
  const timestamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return `${safeLabel}-${timestamp}`;
}

function ensureVisualArtifactLayout(options = {}) {
  const opts = asObject(options);
  const projectPath = resolveProjectPath(opts);
  const runtimeRoot = resolveVisualRuntimeRoot({ projectPath });
  const artifactsRoot = asString(opts.artifactRoot, '')
    ? path.resolve(asString(opts.artifactRoot, ''))
    : path.join(runtimeRoot, 'screenshots', 'visual-captures');
  const runId = asString(opts.runId, '') || buildVisualRunId(opts.label || 'capture', opts.nowMs || Date.now());
  const runDir = path.join(artifactsRoot, runId);
  const baselineDir = path.join(runDir, 'baseline');
  const currentDir = path.join(runDir, 'current');
  const diffDir = path.join(runDir, 'diff');
  const metaDir = path.join(runDir, 'meta');
  const manifestPath = path.join(runDir, 'manifest.json');

  ensureDir(baselineDir);
  ensureDir(currentDir);
  ensureDir(diffDir);
  ensureDir(metaDir);

  return {
    projectPath,
    runtimeRoot,
    artifactsRoot,
    runId,
    runDir,
    baselineDir,
    currentDir,
    diffDir,
    metaDir,
    manifestPath,
  };
}

function resolveKindDir(layout, kind = 'meta') {
  const normalized = asString(kind, 'meta').toLowerCase();
  if (normalized === 'baseline') return layout.baselineDir;
  if (normalized === 'current') return layout.currentDir;
  if (normalized === 'diff') return layout.diffDir;
  return layout.metaDir;
}

function writeSnapshotImage(layout, kind, fileName, data) {
  const dirPath = resolveKindDir(layout, kind);
  const targetName = asString(fileName, '') || 'snapshot.png';
  const targetPath = path.join(dirPath, targetName);

  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(String(data || ''), 'base64');

  fs.writeFileSync(targetPath, buffer);
  return {
    path: targetPath,
    bytes: buffer.length,
    kind: asString(kind, 'meta'),
    fileName: targetName,
  };
}

function writeSnapshotJson(layout, fileName, payload, options = {}) {
  const opts = asObject(options);
  const dirPath = resolveKindDir(layout, opts.kind || 'meta');
  const targetName = asString(fileName, '') || 'data.json';
  const targetPath = path.join(dirPath, targetName);
  const spacing = asPositiveInt(opts.space, 2);
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, spacing)}\n`, 'utf8');
  return {
    path: targetPath,
    fileName: targetName,
  };
}

function writeVisualRunManifest(layout, manifest = {}) {
  const payload = {
    runId: layout.runId,
    runDir: layout.runDir,
    generatedAt: new Date().toISOString(),
    ...asObject(manifest),
  };
  fs.writeFileSync(layout.manifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return {
    path: layout.manifestPath,
    payload,
  };
}

function resolveLatestScreenshotPath(options = {}) {
  const opts = asObject(options);
  if (asString(opts.latestPath, '')) return path.resolve(asString(opts.latestPath, ''));
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('screenshots', 'latest.png'), { forWrite: true });
  }
  const root = resolveVisualRuntimeRoot(opts);
  return path.join(root, 'screenshots', 'latest.png');
}

function resolveSquidrunRootFallback() {
  try {
    return typeof getSquidrunRoot === 'function' ? getSquidrunRoot() : null;
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_HEURISTIC_PORTS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_READY_POLL_MS,
  sleep,
  ensureDir,
  asString,
  asObject,
  asPositiveInt,
  normalizeUrlCandidate,
  applyRouteToUrl,
  parsePortHintsFromText,
  detectFrameworkHints,
  frameworkDefaultPorts,
  readJsonFileSafe,
  writeJsonAtomic,
  resolveProjectPath,
  resolveVisualRuntimeRoot,
  buildHeuristicUrlCandidates,
  resolveVisualUrlCandidates,
  resolveVisualUrl,
  probeHttpReadiness,
  waitForHttpReady,
  resolveReadyVisualUrl,
  getVisualUrlCachePath,
  readVisualUrlCache,
  writeVisualUrlCache,
  readCachedVisualUrl,
  writeCachedVisualUrl,
  buildVisualRunId,
  ensureVisualArtifactLayout,
  writeSnapshotImage,
  writeSnapshotJson,
  writeVisualRunManifest,
  resolveLatestScreenshotPath,
  resolveSquidrunRootFallback,
};
