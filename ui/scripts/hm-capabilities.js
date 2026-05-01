#!/usr/bin/env node
'use strict';

/**
 * hm-capabilities: runtime tool-manifest generator + capability lookup CLI.
 *
 * Usage:
 *   node ui/scripts/hm-capabilities.js list [--json]
 *   node ui/scripts/hm-capabilities.js search <term> [--limit <n>]
 *   node ui/scripts/hm-capabilities.js verify "<claim>"
 */

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../config');

const SCRIPTS_DIR = __dirname;
const MANIFEST_PATH = resolveCoordPath(path.join('runtime', 'tool-manifest.json'), { forWrite: true });
const SCRIPT_PATTERN = /^hm-[a-z0-9-]+\.js$/i;
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'get',
  'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'me', 'my', 'no', 'not',
  'of', 'on', 'or', 'our', 'run', 'script', 'show', 'that', 'the', 'their',
  'there', 'this', 'to', 'tool', 'tools', 'use', 'we', 'what', 'when', 'with',
  'without', 'you', 'your',
]);
const NEGATIVE_CLAIM_PATTERN = /\b(can(?:not|'t)|unable|don't|do not|doesn't|does not|no|not|without|missing|lack|lacking|unavailable)\b/i;
const CATEGORY_ORDER = ['memory', 'comms', 'visual', 'external-integrations', 'system'];

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const positional = [];
  const flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '');
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !String(next).startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positional, flags };
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node ui/scripts/hm-capabilities.js list [--json]',
    '  node ui/scripts/hm-capabilities.js search <term> [--limit <n>]',
    '  node ui/scripts/hm-capabilities.js verify "<claim>"',
    '',
  ].join('\n'));
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && token.length > 1 && !STOPWORDS.has(token));
}

function uniqueList(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeDescription(value, fileId) {
  const raw = String(value || '').trim();
  if (!raw) return humanizeId(fileId);

  if (raw.toLowerCase() === fileId.toLowerCase()) {
    return humanizeId(fileId);
  }

  return raw;
}

function humanizeId(fileId) {
  return String(fileId || '')
    .replace(/^hm-/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function stripCommentDecorators(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\* ?/, '').replace(/^\s*\/\/ ?/, '').trimRight())
    .join('\n');
}

function extractLeadingComment(content) {
  const source = String(content || '')
    .replace(/^#!.*\r?\n/, '')
    .replace(/^\s*['"]use strict['"];\s*\r?\n/, '');

  const blockMatch = source.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
  if (blockMatch) {
    return stripCommentDecorators(blockMatch[1]).trim();
  }

  const lines = source.split(/\r?\n/);
  const buffer = [];
  for (const line of lines) {
    if (/^\s*\/\//.test(line)) {
      buffer.push(line);
      continue;
    }
    if (!line.trim() && buffer.length > 0) {
      break;
    }
    if (line.trim()) {
      break;
    }
  }

  return stripCommentDecorators(buffer.join('\n')).trim();
}

function extractUsageLines(headerText) {
  if (!headerText) return [];
  const lines = String(headerText).split(/\r?\n/);
  const usage = [];
  let capturing = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!capturing && /^usage\b/i.test(line)) {
      capturing = true;
      const inline = line.replace(/^usage\s*:\s*/i, '').trim();
      if (inline) usage.push(inline);
      continue;
    }

    if (!capturing) continue;
    if (!line) {
      if (usage.length > 0) break;
      continue;
    }

    if (/^(node|npm|npx|yarn|pnpm)\b/i.test(line) || /^[.-]\s+/.test(line) || /^--[a-z0-9-]+/i.test(line)) {
      usage.push(line);
      continue;
    }

    break;
  }

  return uniqueList(usage);
}

function extractDescription(headerText, fileId) {
  const lines = String(headerText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/^usage\b/i.test(line)) continue;

    if (line.includes('—')) {
      const [left, right] = line.split('—', 2);
      if (left && left.toLowerCase().includes(fileId.toLowerCase()) && right && right.trim()) {
        return normalizeDescription(right, fileId);
      }
    }

    if (line.includes(' - ')) {
      const [left, right] = line.split(/\s+-\s+/, 2);
      if (left && left.toLowerCase().includes(fileId.toLowerCase()) && right && right.trim()) {
        return normalizeDescription(right, fileId);
      }
    }

    if (line.toLowerCase() !== fileId.toLowerCase()) {
      return normalizeDescription(line, fileId);
    }
  }

  return humanizeId(fileId);
}

function extractSubcommandsFromUsage(usageLines, fileName) {
  const subcommands = [];
  const targets = [fileName, `ui/scripts/${fileName}`, `scripts/${fileName}`].map((value) => value.toLowerCase());

  usageLines.forEach((line) => {
    const raw = String(line || '');
    const lowerRaw = raw.toLowerCase();
    for (const target of targets) {
      const index = lowerRaw.indexOf(target);
      if (index === -1) continue;

      const remainder = raw.slice(index + target.length).trim();
      if (!remainder || /^[-\u2013\u2014"']/.test(remainder)) {
        break;
      }

      const candidate = remainder.split(/\s+/)[0];
      if (
        candidate
        && !candidate.startsWith('--')
        && !candidate.startsWith('<')
        && !candidate.startsWith('[')
        && /^[a-z][a-z0-9:-]*$/i.test(candidate)
      ) {
        subcommands.push(candidate.replace(/[,.;]+$/, ''));
      }
      break;
    }
  });

  return subcommands;
}

function extractSubcommandsFromCode(content) {
  const source = String(content || '');
  const commands = [];
  const commandRegex = /(?:if|else if)\s*\(\s*command\s*===\s*['"`]([^'"`]+)['"`]/g;
  const defaultRegex = /\bcommand\s*=\s*[^;\n]*\|\|\s*['"`]([^'"`]+)['"`]/g;

  let match = null;
  while ((match = commandRegex.exec(source)) !== null) {
    commands.push(match[1]);
  }
  while ((match = defaultRegex.exec(source)) !== null) {
    commands.push(match[1]);
  }

  return commands;
}

function inferCategories(fileId, description, usageLines, subcommands) {
  const haystack = `${fileId} ${description} ${(usageLines || []).join(' ')} ${(subcommands || []).join(' ')}`.toLowerCase();
  if (/\b(capabilit|manifest)\b/.test(haystack)) {
    return {
      primaryCategory: 'system',
      categories: ['system'],
    };
  }
  const categories = [];

  if (/memory/.test(haystack)) {
    categories.push('memory');
  }
  if (/(send|comms|claim|telegram|sms|twitter|reddit|message|broadcast|relay|pane|transition)/.test(haystack)) {
    categories.push('comms');
  }
  if (/(visual|screenshot|image|subtitle|photo|capture|smoke)/.test(haystack)) {
    categories.push('visual');
  }
  if (/(github|telegram|sms|twitter|reddit|twilio|external)/.test(haystack)) {
    categories.push('external-integrations');
  }

  if (categories.length === 0) {
    categories.push('system');
  }

  const uniqueCategories = uniqueList(categories).sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
  return {
    primaryCategory: uniqueCategories[0] || 'system',
    categories: uniqueCategories,
  };
}

function inferRiskLevel(fileId, description, subcommands) {
  const haystack = `${fileId} ${description} ${(subcommands || []).join(' ')}`.toLowerCase();
  if (/(execute|close|trade|full-send|deposit|bridge|swap|delete|kill|restore|fresh|cancel|approve|promote)/.test(haystack)) {
    return 'high';
  }
  if (/(send|telegram|sms|twitter|reddit|github|ingest|enqueue|claim|transition|pane|experiment|doctor|backtest)/.test(haystack)) {
    return 'medium';
  }
  return 'low';
}

function buildSearchTokens(tool) {
  const combined = [
    tool.id,
    tool.description,
    tool.command,
    tool.primaryCategory,
    ...(tool.categories || []),
    ...(tool.tags || []),
    ...(tool.subcommands || []),
    ...(tool.usage || []),
  ].join(' ');
  return uniqueList(tokenize(combined));
}

function readToolRecord(fileName, options = {}) {
  const scriptsDir = options.scriptsDir || SCRIPTS_DIR;
  const scriptPath = path.join(scriptsDir, fileName);
  const content = fs.readFileSync(scriptPath, 'utf8');
  const fileId = path.basename(fileName, '.js');
  const headerText = extractLeadingComment(content);
  const usageLines = extractUsageLines(headerText);
  const subcommands = uniqueList([
    ...extractSubcommandsFromUsage(usageLines, fileName),
    ...extractSubcommandsFromCode(content),
  ]);
  const description = extractDescription(headerText, fileId);
  const { primaryCategory, categories } = inferCategories(fileId, description, usageLines, subcommands);
  const riskLevel = inferRiskLevel(fileId, description, subcommands);
  const tags = uniqueList([
    primaryCategory,
    ...categories,
    ...subcommands,
    ...fileId.split('-').filter((part) => part && part !== 'hm'),
  ]);

  const record = {
    id: fileId,
    scriptPath: path.relative(path.resolve(path.join(__dirname, '..', '..')), scriptPath).replace(/\\/g, '/'),
    command: `node ui/scripts/${fileName}`,
    description,
    usage: usageLines,
    subcommands,
    primaryCategory,
    categories,
    riskLevel,
    tags,
  };

  record.searchTokens = buildSearchTokens(record);
  return record;
}

function listScriptFiles(options = {}) {
  const scriptsDir = options.scriptsDir || SCRIPTS_DIR;
  return fs.readdirSync(scriptsDir)
    .filter((fileName) => SCRIPT_PATTERN.test(fileName))
    .sort((a, b) => a.localeCompare(b));
}

function buildManifest(options = {}) {
  const scriptsDir = options.scriptsDir || SCRIPTS_DIR;
  const manifestPath = options.manifestPath || MANIFEST_PATH;
  const write = options.write !== false;
  const generatedAt = options.generatedAt || new Date().toISOString();
  const projectRoot = path.resolve(path.join(__dirname, '..', '..'));
  const files = listScriptFiles({ scriptsDir });
  const tools = files.map((fileName) => readToolRecord(fileName, { scriptsDir }));

  const manifest = {
    generatedAt,
    manifestPath: path.resolve(manifestPath),
    scriptsDir: path.resolve(scriptsDir),
    projectRoot,
    toolCount: tools.length,
    tools,
  };

  if (write) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  return manifest;
}

function scoreToolMatch(tool, queryTokens, normalizedQuery) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) return 0;

  const haystack = [
    tool.id,
    tool.description,
    tool.command,
    tool.primaryCategory,
    ...(tool.categories || []),
    ...(tool.subcommands || []),
    ...(tool.usage || []),
    ...(tool.tags || []),
  ].join(' ').toLowerCase();

  let score = 0;
  if (normalizedQuery && haystack.includes(normalizedQuery)) {
    score += 10;
  }

  queryTokens.forEach((token) => {
    if ((tool.searchTokens || []).includes(token)) score += 3;
    if (tool.id.toLowerCase().includes(token)) score += 2;
    if (tool.primaryCategory.toLowerCase().includes(token)) score += 2;
    if ((tool.subcommands || []).some((command) => String(command).toLowerCase() === token)) score += 2;
    if (haystack.includes(token)) score += 1;
  });

  return score;
}

function searchManifest(manifest, query, options = {}) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const queryTokens = tokenize(query);
  const limit = Number.parseInt(options.limit, 10) > 0 ? Number.parseInt(options.limit, 10) : 10;

  const matches = (manifest.tools || [])
    .map((tool) => ({
      ...tool,
      score: scoreToolMatch(tool, queryTokens, normalizedQuery),
    }))
    .filter((tool) => tool.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);

  return {
    query,
    normalizedQuery,
    matchCount: matches.length,
    matches,
  };
}

function verifyClaim(manifest, claim) {
  const query = String(claim || '').trim();
  const result = searchManifest(manifest, query, { limit: 5 });
  const negativeClaim = NEGATIVE_CLAIM_PATTERN.test(query);
  const supported = result.matchCount > 0;

  return {
    claim: query,
    negativeClaim,
    supported,
    contradicted: negativeClaim && supported,
    recommendation: negativeClaim && supported
      ? 'Capability exists locally. Run the matching tool or cite a fresh capability lookup before denying access.'
      : supported
        ? 'Capability evidence found locally.'
        : 'No matching tool was found. Do a manual repo check before making a hard negative claim.',
    matches: result.matches,
  };
}

function printList(manifest, asJson = false) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  const lines = [
    `[hm-capabilities] manifest=${manifest.manifestPath}`,
    `[hm-capabilities] tools=${manifest.toolCount}`,
  ];

  manifest.tools.forEach((tool) => {
    lines.push(`- ${tool.id} [${tool.primaryCategory}/${tool.riskLevel}] ${tool.description}`);
  });

  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'list';
  const manifest = buildManifest();

  if (command === 'list') {
    printList(manifest, flags.json === true);
    return;
  }

  if (command === 'search') {
    const query = positional.slice(1).join(' ').trim();
    if (!query) throw new Error('search requires a query');
    process.stdout.write(`${JSON.stringify(searchManifest(manifest, query, { limit: flags.limit }), null, 2)}\n`);
    return;
  }

  if (command === 'verify') {
    const claim = positional.slice(1).join(' ').trim();
    if (!claim) throw new Error('verify requires a claim string');
    process.stdout.write(`${JSON.stringify(verifyClaim(manifest, claim), null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    printUsage();
    process.exit(1);
  }
}

module.exports = {
  MANIFEST_PATH,
  buildManifest,
  extractDescription,
  extractLeadingComment,
  extractSubcommandsFromCode,
  extractSubcommandsFromUsage,
  extractUsageLines,
  humanizeId,
  inferCategories,
  inferRiskLevel,
  listScriptFiles,
  parseArgs,
  readToolRecord,
  scoreToolMatch,
  searchManifest,
  tokenize,
  verifyClaim,
};
