'use strict';

const fs = require('fs');
const path = require('path');

const MIRA_WEB_RESEARCH_CURIOSITY_SCHEMA = 'squidrun.mira.web_research_curiosity_read_v0';
const DEFAULT_MAX_FILES = 18;
const DEFAULT_MAX_BYTES = 24000;

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function oneLine(value, max = 220) {
  const text = trimText(value).replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeRelativePath(projectRoot, filePath) {
  const relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

function defaultResearchRoots(projectRoot) {
  return [
    { bucket: 'coord_research', dir: path.join(projectRoot, '.squidrun', 'coord') },
    { bucket: 'workspace_research', dir: path.join(projectRoot, 'workspace', 'research') },
    { bucket: 'workspace_specs', dir: path.join(projectRoot, 'workspace', 'specs') },
    { bucket: 'workspace_logs', dir: path.join(projectRoot, 'workspace', 'logs') },
    { bucket: 'workspace_build', dir: path.join(projectRoot, 'workspace', 'build') },
  ];
}

function safeUrlForOutput(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return null;
  }
}

function safeHostname(value) {
  try {
    return new URL(String(value)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function extractUrls(text) {
  return Array.from(new Set((String(text || '').match(/https?:\/\/[^\s<>)"'`]+/g) || [])
    .map((url) => url.replace(/[.,;:!?]+$/, ''))
    .map(safeUrlForOutput)
    .filter(Boolean)))
    .slice(0, 8);
}

function stripRawUrlDetails(text) {
  return String(text || '').replace(/https?:\/\/[^\s<>)"'`]+/g, (url) => safeUrlForOutput(url) || '[url]');
}

function extractTitle(text, fallback) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,3}\s+/.test(line));
  if (heading) return oneLine(heading.replace(/^#{1,3}\s+/, ''), 120);
  const named = lines.find((line) => !/^[-*]\s+/.test(line) && line.length <= 160);
  return oneLine(named || fallback, 120);
}

function extractExcerpt(text) {
  const paragraph = String(text || '').split(/\r?\n\r?\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .find((block) => block && !/^#{1,6}\s+/.test(block));
  return oneLine(stripRawUrlDetails(paragraph || text), 260);
}

function normalizeResearchRoots(payload = {}, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const rawRoots = options.researchRoots || payload.researchRoots || payload.roots;
  if (rawRoots) {
    return asArray(rawRoots).map((entry, index) => {
      if (entry && typeof entry === 'object') {
        return {
          bucket: trimText(entry.bucket || entry.source || `research_${index + 1}`) || `research_${index + 1}`,
          dir: path.resolve(projectRoot, trimText(entry.dir || entry.path || entry.root)),
        };
      }
      return {
        bucket: `research_${index + 1}`,
        dir: path.resolve(projectRoot, trimText(entry)),
      };
    }).filter((entry) => entry.dir);
  }
  return defaultResearchRoots(projectRoot);
}

function collectResearchFiles(projectRoot, roots, maxFiles) {
  const files = [];
  const allowedExt = new Set(['.md', '.txt', '.json', '.jsonl']);
  for (const root of roots) {
    if (!root.dir || !fs.existsSync(root.dir)) continue;
    const stack = [root.dir];
    while (stack.length > 0 && files.length < maxFiles * 4) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!/backup|node_modules|\.git|private-overlays/i.test(entry.name)) stack.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !allowedExt.has(path.extname(entry.name).toLowerCase())) continue;
        if (!/(research|web|browser|url|assistant|market|proposal|playbook|study|radar|deep)/i.test(entry.name)) continue;
        try {
          const stat = fs.statSync(fullPath);
          files.push({
            bucket: root.bucket,
            path: fullPath,
            size: stat.size,
            modifiedMs: stat.mtimeMs,
            modified: stat.mtime.toISOString(),
          });
        } catch {}
      }
    }
  }
  return files
    .sort((left, right) => right.modifiedMs - left.modifiedMs || left.path.localeCompare(right.path))
    .slice(0, maxFiles);
}

function readSnippet(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.slice(0, bytes).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readMiraWebResearchCuriosity(payload = {}, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const roots = normalizeResearchRoots(payload, { ...options, projectRoot });
  const maxFiles = Math.max(1, Math.min(40, Number(payload.limit || options.limit || DEFAULT_MAX_FILES) || DEFAULT_MAX_FILES));
  const maxBytes = Math.max(1000, Math.min(64000, Number(payload.maxBytes || options.maxBytes || DEFAULT_MAX_BYTES) || DEFAULT_MAX_BYTES));
  const files = collectResearchFiles(projectRoot, roots, maxFiles);

  if (files.length === 0) {
    return {
      schema: MIRA_WEB_RESEARCH_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: 'web_research_artifacts_missing',
      checked_roots: roots.map((root) => ({
        bucket: root.bucket,
        exists: fs.existsSync(root.dir),
      })),
      result_count: 0,
      results: [],
      no_mutation_performed: true,
    };
  }

  const results = files.map((file) => {
    let text = '';
    try {
      text = readSnippet(file.path, maxBytes);
    } catch {
      return null;
    }
    const safeUrls = extractUrls(text);
    const domains = Array.from(new Set(safeUrls.map(safeHostname).filter(Boolean))).slice(0, 8);
    return {
      source_bucket: file.bucket,
      path: safeRelativePath(projectRoot, file.path),
      title: extractTitle(text, path.basename(file.path)),
      excerpt: extractExcerpt(text),
      modified_at: file.modified,
      size_bytes: file.size,
      domains,
      safe_urls: safeUrls.slice(0, 4),
    };
  }).filter((entry) => entry?.path);

  const domainCounts = results.flatMap((entry) => entry.domains).reduce((acc, domain) => {
    acc[domain] = (acc[domain] || 0) + 1;
    return acc;
  }, {});
  const top_domains = Object.entries(domainCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([domain, count]) => ({ domain, count }));
  const buckets = results.reduce((acc, entry) => {
    acc[entry.source_bucket] = (acc[entry.source_bucket] || 0) + 1;
    return acc;
  }, {});

  return {
    schema: MIRA_WEB_RESEARCH_CURIOSITY_SCHEMA,
    ok: true,
    decision: 'web_research_artifacts_read_only',
    result_count: results.length,
    top_domains,
    buckets,
    results,
    no_mutation_performed: true,
    consequence_controls: {
      internal_only: true,
      read_only: true,
      network_performed: false,
      browser_mutation_performed: false,
      raw_query_strings_exposed: false,
      external_send_performed: false,
    },
  };
}

module.exports = {
  MIRA_WEB_RESEARCH_CURIOSITY_SCHEMA,
  defaultResearchRoots,
  readMiraWebResearchCuriosity,
};
